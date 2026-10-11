import {
  AppError,
  isLoopbackEndpoint,
  type InspectorDevtoolsRepository,
  type InspectorDevtoolsTarget,
} from '@dsh-vscode/domain'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { assertValidEndpoint, releaseUnreadBody } from '../../transport-internal.js'
import { httpFailure, normalizeTransportError } from '../../transport-errors.js'

const malformed = (): AppError =>
  new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'The optional DSH Inspector returned an invalid target.',
    retryable: false,
  })

/** Pinned experimental Inspector bootstrap + worker discovery, never port scanning. */
export class Alpha211InspectorRepository implements InspectorDevtoolsRepository {
  private readonly closed = new AbortController()
  public constructor(
    private readonly options: Pick<
      AlphaLoopbackApiClientOptions,
      'endpoint' | 'fetch' | 'authCookie' | 'requestTimeoutMs'
    > & { readonly allowWorkerDiscovery?: () => boolean },
  ) {
    assertValidEndpoint(options.endpoint)
  }
  public async discover(signal?: AbortSignal): Promise<InspectorDevtoolsTarget> {
    if (!isLoopbackEndpoint(this.options.endpoint) || this.options.allowWorkerDiscovery?.() === false)
      return { available: false }
    const combined = AbortSignal.any([
      this.closed.signal,
      AbortSignal.timeout(this.options.requestTimeoutMs),
      ...(signal === undefined ? [] : [signal]),
    ])
    try {
      const cookie = this.options.authCookie?.(this.options.endpoint)
      const bootstrap = await this.get(
        new URL('/api/experimental-inspector/bootstrap', this.options.endpoint.baseUrl),
        combined,
        cookie === undefined ? {} : { Cookie: cookie },
        true,
      )
      if (bootstrap === undefined) return { available: false }
      const endpointValue = record(bootstrap).endpoint
      if (typeof endpointValue !== 'string' || endpointValue.length > 256) throw malformed()
      let endpoint: URL
      try {
        endpoint = new URL(endpointValue)
      } catch {
        throw malformed()
      }
      const announcedPort = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/ingest$/u.exec(endpointValue)?.[1]
      // The pinned worker binds only this numeric loopback address. No DNS or redirects.
      if (
        announcedPort === undefined ||
        endpoint.protocol !== 'ws:' ||
        endpoint.hostname !== '127.0.0.1' ||
        endpoint.pathname !== '/ingest' ||
        endpoint.username !== '' ||
        endpoint.password !== '' ||
        endpoint.search !== '' ||
        endpoint.hash !== '' ||
        Number(announcedPort) > 65535
      )
        throw malformed()
      // URL canonicalization omits the ws default port 80; preserve the explicitly
      // announced port in the pinned debugger/frontend wire strings.
      const workerHost = `127.0.0.1:${announcedPort}`
      const origin = `http://${workerHost}`
      // Never send the main DSH Cookie or ingest protocol to the worker.
      const version = record(await this.get(new URL('/json/version', origin), combined, {}))
      if (version.Browser !== 'dsh-experimental-inspector/0' || version['Protocol-Version'] !== '1.3')
        throw malformed()
      const targets = await this.get(new URL('/json/list', origin), combined, {})
      if (!Array.isArray(targets) || targets.length !== 1) throw malformed()
      const target = record(targets[0])
      if (
        typeof target.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(target.id) ||
        target.type !== 'page' ||
        target.title !== 'DeepSeek Harness Host' ||
        target.url !== 'dsh://host'
      )
        throw malformed()
      const socket = `ws://${workerHost}/devtools/page/${target.id}`
      const frontendUrl = `devtools://devtools/bundled/devtools_app.html?ws=${workerHost}/devtools/page/${target.id}&panel=elements&noJavaScriptCompletion=true`
      if (
        target.webSocketDebuggerUrl !== socket ||
        version.webSocketDebuggerUrl !== socket ||
        target.devtoolsFrontendUrl !== frontendUrl
      )
        throw malformed()
      if (combined.aborted) throw new Error('cancelled')
      return { available: true, frontendUrl }
    } catch (error) {
      if (signal?.aborted || this.closed.signal.aborted)
        throw new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'Inspector discovery was cancelled.',
          retryable: false,
        })
      if (error instanceof AppError) throw error
      throw normalizeTransportError('inspector.discover', error, signal)
    }
  }
  public close(): Promise<void> {
    this.closed.abort()
    return Promise.resolve()
  }
  private async get(
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>,
    optional = false,
  ): Promise<unknown> {
    if (signal.aborted) throw new Error('cancelled')
    const response = await this.options.fetch(url, { method: 'GET', headers, redirect: 'error', signal })
    if (!response.ok) {
      await releaseUnreadBody(response)
      if (optional && response.status === 404) return undefined
      throw httpFailure('inspector.discover', response.status)
    }
    const reader = response.body?.getReader()
    if (reader === undefined) throw malformed()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        if (signal.aborted) throw new Error('cancelled')
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 32_768) throw malformed()
        chunks.push(chunk.value)
      }
      const buffer = new Uint8Array(bytes)
      let offset = 0
      for (const chunk of chunks) {
        buffer.set(chunk, offset)
        offset += chunk.byteLength
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as unknown
      } catch {
        throw malformed()
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed()
  return value as Record<string, unknown>
}
