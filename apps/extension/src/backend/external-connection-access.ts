import { createHash } from 'node:crypto'
import { AppError, isLoopbackEndpoint, type BackendEndpoint } from '@dsh-vscode/domain'
import { type EndpointNetwork, waitForSignal } from './endpoint-network.js'

interface EndpointCredentials {
  readonly version: 1
  readonly approved: true
  readonly allowInsecureHttp: boolean
  readonly addressFingerprint?: string
  readonly launchToken?: string
  readonly cookie?: string
  readonly cookieExpiresAt?: number
}

export interface ExternalConnectionAccessDependencies {
  readonly secrets: {
    get(key: string): PromiseLike<string | undefined>
    store(key: string, value: string): PromiseLike<void>
    delete(key: string): PromiseLike<void>
  }
  readonly network: EndpointNetwork
  readonly isTrusted: () => boolean
  readonly requestTimeoutMs: () => number
  readonly confirm: (endpoint: BackendEndpoint, insecure: boolean) => Promise<boolean>
  readonly inputToken: () => Promise<string | undefined>
  readonly now?: () => number
}

/** Only the Host holds endpoint grants, launch tokens and cookies. Persistent storage is per origin. */
export class ExternalConnectionAccess {
  private readonly cookies = new Map<string, string>()
  private readonly closed = new AbortController()
  private readonly writes = new Map<string, Promise<void>>()
  private generation = 0
  private revisionAbort = new AbortController()
  private readonly now: () => number

  public constructor(private readonly dependencies: ExternalConnectionAccessDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  public get revision(): number {
    return this.generation
  }

  public cookie(endpoint: BackendEndpoint): string | undefined {
    return this.cookies.get(endpoint.baseUrl)
  }

  public async authorize(endpoint: BackendEndpoint, callerSignal?: AbortSignal): Promise<void> {
    callerSignal?.throwIfAborted()
    this.requireTrust()
    const insecure = !isLoopbackEndpoint(endpoint) && new URL(endpoint.baseUrl).protocol === 'http:'
    if (!(await this.dependencies.confirm(endpoint, insecure))) throw cancelled()
    this.requireTrust()
    const token = await this.dependencies.inputToken()
    callerSignal?.throwIfAborted()
    if (token === undefined) throw cancelled()
    if (token.length > 4096 || /[\r\n\0]/u.test(token))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH launch token is invalid.',
        retryable: false,
      })
    const generation = this.advanceRevision()
    this.cookies.delete(endpoint.baseUrl)
    const signal = AbortSignal.any([
      this.closed.signal,
      this.revisionAbort.signal,
      ...(callerSignal === undefined ? [] : [callerSignal]),
      AbortSignal.timeout(this.dependencies.requestTimeoutMs()),
    ])
    try {
      const fingerprint = await this.dependencies.network.prepare(endpoint, insecure, signal)
      signal.throwIfAborted()
      this.requireTrust()
      await this.write(
        endpoint,
        {
          version: 1,
          approved: true,
          allowInsecureHttp: insecure,
          ...(insecure ? { addressFingerprint: fingerprint } : {}),
          ...(token.trim() === '' ? {} : { launchToken: token }),
        },
        signal,
        generation,
      )
    } catch (error) {
      if (generation === this.generation) await this.dependencies.network.release(endpoint)
      throw error
    }
  }

  public async clear(endpoint: BackendEndpoint): Promise<void> {
    this.requireTrust()
    this.advanceRevision()
    this.cookies.delete(endpoint.baseUrl)
    await this.dependencies.network.release(endpoint)
    try {
      await this.enqueue(endpoint, async () => {
        await this.dependencies.secrets.delete(storageKey(endpoint))
      })
    } catch {
      throw new AppError({
        code: 'AUTH_REQUIRED',
        message: 'The connection credentials could not be removed from secure storage.',
        retryable: true,
      })
    }
  }

  public async prepare(endpoint: BackendEndpoint, callerSignal: AbortSignal): Promise<void> {
    const generation = this.generation
    try {
      await this.prepareOnce(endpoint, callerSignal)
    } catch (error) {
      if (generation === this.generation) {
        this.cookies.delete(endpoint.baseUrl)
        await this.dependencies.network.release(endpoint)
      }
      throw error
    }
  }

  private async prepareOnce(endpoint: BackendEndpoint, callerSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([
      callerSignal,
      this.closed.signal,
      this.revisionAbort.signal,
      AbortSignal.timeout(this.dependencies.requestTimeoutMs()),
    ])
    signal.throwIfAborted()
    const generation = this.generation
    const record = await waitForSignal(this.read(endpoint), signal)
    signal.throwIfAborted()
    if ((!isLoopbackEndpoint(endpoint) || record !== undefined) && !this.dependencies.isTrusted())
      throw denied()
    if (!isLoopbackEndpoint(endpoint) && record === undefined) throw denied()
    if (record?.allowInsecureHttp === true && record.addressFingerprint === undefined) throw denied()
    await this.dependencies.network.prepare(
      endpoint,
      record?.allowInsecureHttp ?? false,
      signal,
      record?.addressFingerprint,
    )
    signal.throwIfAborted()
    this.cookies.delete(endpoint.baseUrl)
    if (record === undefined) return
    let credentials = record
    if (
      credentials.cookie !== undefined &&
      credentials.cookieExpiresAt !== undefined &&
      credentials.cookieExpiresAt > this.now()
    ) {
      const response = await this.dependencies.network.fetch(`${endpoint.baseUrl}/api`, {
        method: 'GET',
        headers: { Cookie: credentials.cookie },
        redirect: 'error',
        signal,
      })
      await releaseResponse(response)
      signal.throwIfAborted()
      if (response.status !== 401 && response.status !== 403) {
        if (generation !== this.generation) throw cancelled()
        this.cookies.set(endpoint.baseUrl, credentials.cookie)
        return
      }
    }
    if (credentials.cookie !== undefined) {
      credentials = withoutCookie(credentials)
      await this.write(endpoint, credentials, signal, generation)
    }
    if (credentials.launchToken === undefined) return
    const response = await this.dependencies.network.fetch(
      `${endpoint.baseUrl}/?token=${encodeURIComponent(credentials.launchToken)}`,
      { method: 'GET', redirect: 'manual', signal },
    )
    const cookie = parseSessionCookie(response, this.now(), new URL(endpoint.baseUrl).protocol === 'https:')
    await releaseResponse(response)
    signal.throwIfAborted()
    if (generation !== this.generation) throw cancelled()
    if (cookie === undefined)
      throw new AppError({
        code: 'AUTH_REQUIRED',
        message:
          'DSH authentication failed. Use DSH: Authorize External Connection to update the launch token.',
        retryable: true,
      })
    await this.write(
      endpoint,
      { ...credentials, cookie: cookie.value, cookieExpiresAt: cookie.expiresAt },
      signal,
      generation,
    )
    signal.throwIfAborted()
    if (generation !== this.generation) throw cancelled()
    this.cookies.set(endpoint.baseUrl, cookie.value)
  }

  public async release(endpoint?: BackendEndpoint): Promise<void> {
    if (endpoint === undefined) this.cookies.clear()
    else this.cookies.delete(endpoint.baseUrl)
    await this.dependencies.network.release(endpoint)
  }

  public async dispose(): Promise<void> {
    this.closed.abort()
    this.cookies.clear()
    await this.dependencies.network.dispose()
    await Promise.allSettled([...this.writes.values()])
  }

  private requireTrust(): void {
    if (!this.dependencies.isTrusted() || this.closed.signal.aborted) throw denied()
  }

  private advanceRevision(): number {
    this.revisionAbort.abort()
    this.revisionAbort = new AbortController()
    return ++this.generation
  }

  private async read(endpoint: BackendEndpoint): Promise<EndpointCredentials | undefined> {
    try {
      await this.writes.get(endpoint.baseUrl)
      const value = await this.dependencies.secrets.get(storageKey(endpoint))
      if (value === undefined) return undefined
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        return undefined
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
      const fields = parsed as Record<string, unknown>
      if (
        fields['version'] !== 1 ||
        fields['approved'] !== true ||
        typeof fields['allowInsecureHttp'] !== 'boolean'
      )
        return undefined
      if (
        fields['launchToken'] !== undefined &&
        (typeof fields['launchToken'] !== 'string' ||
          fields['launchToken'].length > 4096 ||
          /[\r\n\0]/u.test(fields['launchToken']))
      )
        return undefined
      const token = typeof fields['launchToken'] === 'string' ? fields['launchToken'] : undefined
      const cookie =
        typeof fields['cookie'] === 'string' &&
        /^dsh-auth-[a-zA-Z0-9_-]+=[a-zA-Z0-9_.-]+$/u.test(fields['cookie'])
          ? fields['cookie']
          : undefined
      const expires =
        typeof fields['cookieExpiresAt'] === 'number' && Number.isFinite(fields['cookieExpiresAt'])
          ? fields['cookieExpiresAt']
          : undefined
      const fingerprint =
        typeof fields['addressFingerprint'] === 'string' &&
        /^[a-f0-9]{64}$/u.test(fields['addressFingerprint'])
          ? fields['addressFingerprint']
          : undefined
      return {
        version: 1,
        approved: true,
        allowInsecureHttp: fields['allowInsecureHttp'],
        ...(fingerprint === undefined ? {} : { addressFingerprint: fingerprint }),
        ...(token === undefined ? {} : { launchToken: token }),
        ...(cookie === undefined || expires === undefined ? {} : { cookie, cookieExpiresAt: expires }),
      }
    } catch (error) {
      throw new AppError({
        code: 'AUTH_REQUIRED',
        message:
          'Secure connection storage is unavailable. Retry or configure the connection credentials again.',
        retryable: true,
        cause: error,
      })
    }
  }

  private async write(
    endpoint: BackendEndpoint,
    value: EndpointCredentials,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    await waitForSignal(
      this.enqueue(endpoint, async () => {
        signal.throwIfAborted()
        if (generation !== this.generation) throw cancelled()
        try {
          await this.dependencies.secrets.store(storageKey(endpoint), JSON.stringify(value))
        } catch (error) {
          throw new AppError({
            code: 'AUTH_REQUIRED',
            message: 'The connection credentials could not be saved securely.',
            retryable: true,
            cause: error,
          })
        }
        signal.throwIfAborted()
        if (generation !== this.generation) throw cancelled()
      }),
      signal,
    )
  }

  private enqueue(endpoint: BackendEndpoint, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(endpoint.baseUrl) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.writes.set(endpoint.baseUrl, next)
    void next.then(
      () => {
        if (this.writes.get(endpoint.baseUrl) === next) this.writes.delete(endpoint.baseUrl)
      },
      () => {
        if (this.writes.get(endpoint.baseUrl) === next) this.writes.delete(endpoint.baseUrl)
      },
    )
    return next
  }
}

function storageKey(endpoint: BackendEndpoint): string {
  return `dsh.connection.external.${createHash('sha256').update(endpoint.baseUrl).digest('hex')}`
}

function denied(): AppError {
  return new AppError({
    code: 'PERMISSION_DENIED',
    message:
      'Authorize this endpoint in a trusted workspace using DSH: Authorize External Connection before connecting.',
    retryable: false,
  })
}

function cancelled(): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'Connection authorization was cancelled or superseded.',
    retryable: true,
  })
}

function withoutCookie(credentials: EndpointCredentials): EndpointCredentials {
  return {
    version: 1,
    approved: true,
    allowInsecureHttp: credentials.allowInsecureHttp,
    ...(credentials.addressFingerprint === undefined
      ? {}
      : { addressFingerprint: credentials.addressFingerprint }),
    ...(credentials.launchToken === undefined ? {} : { launchToken: credentials.launchToken }),
  }
}

function parseSessionCookie(
  response: Response,
  now: number,
  secure: boolean,
): { readonly value: string; readonly expiresAt: number } | undefined {
  if (response.status !== 303 || response.headers.get('location') !== './') return undefined
  const values = response.headers.getSetCookie()
  for (const header of values) {
    const parts = header.split(';').map((part) => part.trim())
    const value = parts[0]
    if (value === undefined || !/^dsh-auth-[a-zA-Z0-9_-]+=[a-zA-Z0-9_.-]+$/u.test(value)) continue
    if (!parts.some((part) => /^httponly$/iu.test(part)) || !parts.some((part) => /^path=\/$/iu.test(part)))
      continue
    if (
      !parts.some((part) => /^samesite=strict$/iu.test(part)) ||
      (secure && !parts.some((part) => /^secure$/iu.test(part)))
    )
      continue
    const age = parts.find((part) => /^max-age=/iu.test(part))?.slice(8)
    const expires = parts.find((part) => /^expires=/iu.test(part))?.slice(8)
    const expiresAt =
      age !== undefined && /^\d+$/u.test(age)
        ? now + Number(age) * 1000
        : expires === undefined
          ? Number.NaN
          : Date.parse(expires)
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 30 * 24 * 60 * 60 * 1000)
      continue
    return { value, expiresAt }
  }
  return undefined
}

async function releaseResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}
