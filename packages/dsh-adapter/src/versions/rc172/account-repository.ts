import { AppError } from '@dsh-vscode/domain'

import type {
  AccountAuthorizationLaunch,
  AccountClientMetadata,
  AccountLifecycleRepository,
  AccountLifecycleSnapshot,
  AccountSignInAttempt,
  AccountSignInErrorCode,
  AccountSignInPhase,
} from '@dsh-vscode/domain'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** The alpha Gateway transport's pinned Typert Remote carrier, including streams. */
export interface AccountRemoteTransport {
  remoteRequest(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown>
  openRemoteStream(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncIterable<unknown>
}

const ERROR_CODES = new Set<AccountSignInErrorCode>(['network', 'protocol', 'expired', 'storage'])
const PHASES = new Set<AccountSignInPhase>([
  'initializing',
  'waiting-browser',
  'exchanging',
  'committing',
  'succeeded',
  'cancelled',
  'expired',
  'failed',
])
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

/** Exact account-controller Remote adapter for DSH 0.1.7-rc.2. */
export class Rc172AccountLifecycleRepository implements AccountLifecycleRepository {
  private readonly authorizationListeners = new Set<(launch: AccountAuthorizationLaunch) => void>()

  public constructor(private readonly transport: AccountRemoteTransport) {}

  public async getState(signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    return this.readState(await this.call('account/getState', {}, signal), 'account/getState')
  }

  public async startSignIn(
    client: AccountClientMetadata,
    callbackOrigin: string,
    loginSource: 'web' | 'desktop',
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/startSignIn', { client, callbackOrigin, loginSource }, signal)
    return this.readState(raw, 'account/startSignIn')
  }

  public async cancelSignIn(attemptId: string, signal?: AbortSignal): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/cancelSignIn', { attemptId }, signal)
    return this.readState(raw, 'account/cancelSignIn')
  }

  public async hasRunningAccountTasks(signal?: AbortSignal): Promise<boolean> {
    const result = await this.call('account/hasRunningAccountTasks', {}, signal)
    if (typeof result !== 'boolean') throw malformed('account/hasRunningAccountTasks')
    return result
  }

  public async signOut(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountLifecycleSnapshot> {
    const raw = await this.call('account/signOut', { client }, signal)
    return this.readState(raw, 'account/signOut')
  }

  public async *watch(signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot> {
    for await (const raw of this.transport.openRemoteStream('account/watch', {}, signal)) {
      if (signal.aborted) return
      yield this.readState(raw, 'account/watch')
    }
  }

  public async *watchExpiry(signal: AbortSignal): AsyncIterable<'session-expired'> {
    for await (const raw of this.transport.openRemoteStream('account/watchExpiry', {}, signal)) {
      if (signal.aborted) return
      if (raw !== 'session-expired') throw malformed('account/watchExpiry')
      yield raw
    }
  }

  public subscribeAuthorizationLaunch(listener: (launch: AccountAuthorizationLaunch) => void): () => void {
    this.authorizationListeners.add(listener)
    return () => this.authorizationListeners.delete(listener)
  }

  private async call(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const result = await this.transport.remoteRequest(endpoint, args, signal)
    return unwrapRpcResultValue<unknown>(result, endpoint)
  }

  private readState(raw: unknown, method: string): AccountLifecycleSnapshot {
    const record = asRecord(raw)
    if (record === undefined || (record.status !== 'signed-out' && record.status !== 'credential-stored'))
      throw malformed(method)
    const origin = accountOrigin(record.links, method)
    if (!Object.hasOwn(record, 'attempt')) throw malformed(method)
    const rawAttempt = record.attempt
    if (rawAttempt === null) return { status: record.status, attempt: null }
    const attempt = asRecord(rawAttempt)
    if (
      attempt === undefined ||
      typeof attempt.id !== 'string' ||
      !ATTEMPT_ID.test(attempt.id) ||
      typeof attempt.phase !== 'string' ||
      !PHASES.has(attempt.phase as AccountSignInPhase)
    )
      throw malformed(method)

    if (attempt.expiresAt !== undefined && !isTimestamp(attempt.expiresAt)) throw malformed(method)
    if (
      attempt.errorCode !== undefined &&
      (typeof attempt.errorCode !== 'string' || !ERROR_CODES.has(attempt.errorCode as AccountSignInErrorCode))
    )
      throw malformed(method)

    if (attempt.authorizeUrl !== undefined) {
      if (typeof attempt.authorizeUrl !== 'string') throw malformed(method)
      const url = authorizationUrl(attempt.authorizeUrl, origin, method)
      const launch: AccountAuthorizationLaunch = { attemptId: attempt.id, url }
      for (const listener of this.authorizationListeners) {
        try {
          listener(launch)
        } catch {
          // A Host listener failure must not change the DSH-owned account state.
        }
      }
    }

    const safeAttempt: AccountSignInAttempt = {
      id: attempt.id,
      phase: attempt.phase as AccountSignInPhase,
      ...(attempt.expiresAt === undefined ? {} : { expiresAt: attempt.expiresAt }),
      ...(attempt.errorCode === undefined ? {} : { errorCode: attempt.errorCode as AccountSignInErrorCode }),
    }
    return { status: record.status, attempt: safeAttempt }
  }
}

function accountOrigin(value: unknown, method: string): string {
  const links = asRecord(value)
  if (links === undefined || typeof links.usageUrl !== 'string' || typeof links.topUpUrl !== 'string')
    throw malformed(method)
  const usage = safeAccountLink(links.usageUrl, '/usage', method)
  const topUp = safeAccountLink(links.topUpUrl, '/top_up', method)
  if (usage.origin !== topUp.origin) throw malformed(method)
  return usage.origin
}

function safeAccountLink(value: string, path: string, method: string): URL {
  if (value.length > 4_096) throw malformed(method)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformed(method)
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== path ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.protocol === 'http:' && (!isLoopback(url.hostname) || !hasExplicitHttpPort(value)))
  )
    throw malformed(method)
  return url
}

function authorizationUrl(value: string, expectedOrigin: string, method: string): string {
  if (value.length > 8_192) throw malformed(method)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw malformed(method)
  }
  if (
    url.origin !== expectedOrigin ||
    url.pathname !== '/dsh/authorize' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    (url.protocol === 'http:' && (!isLoopback(url.hostname) || !hasExplicitHttpPort(value)))
  )
    throw malformed(method)
  return url.href
}

function hasExplicitHttpPort(value: string): boolean {
  const authority = /^http:\/\/([^/?#]+)/iu.exec(value)?.[1]
  if (authority === undefined || authority.includes('@')) return false
  const port = /:(\d{1,5})$/u.exec(authority)?.[1]
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformed(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed account response for ${method}.`,
    retryable: false,
  })
}
