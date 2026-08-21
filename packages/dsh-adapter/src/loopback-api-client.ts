import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { serverRequestSchema, serverResponseSchema } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import {
  RpcId,
  type ClientResponse,
  type RpcResponse,
  type RpcResult,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { AppError, type BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport, RetryPolicy } from './contracts.js'

export interface LoopbackApiClientOptions {
  readonly endpoint: BackendEndpoint
  readonly requestTimeoutMs: number
  readonly retryPolicy: RetryPolicy
  readonly fetch: typeof globalThis.fetch
  readonly webSocket?: typeof globalThis.WebSocket
}

/** The network boundary. HTTP RPCs and DSH WebSocket event downlinks stay in the Extension Host. */
export class LoopbackApiClient extends AbstractApiClient implements DshTransport {
  private readonly closed = new AbortController()
  private isClosed = false

  public constructor(private readonly options: LoopbackApiClientOptions) {
    super(options.requestTimeoutMs)
    assertLoopback(options.endpoint)
  }

  protected override async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    if (this.isClosed)
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The DSH connection is closed.',
        retryable: true,
      })
    const target = new URL(input.pathname + input.search, this.options.endpoint.baseUrl)
    if (target.origin !== new URL(this.options.endpoint.baseUrl).origin) {
      throw new AppError({
        code: 'INVALID_ENDPOINT',
        message: 'The DSH endpoint changed unexpectedly.',
        retryable: false,
      })
    }
    const response = await this.options.fetch(target, {
      ...init,
      redirect: 'error',
      signal: mergeSignals(init?.signal, this.closed.signal),
    })
    return normalizeLegacyRpcResponse(response)
  }

  public request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse> {
    if (this.isClosed)
      return Promise.reject(
        new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'The DSH connection is closed.',
          retryable: true,
        }),
      )
    return this.withRetry(method, () => this.dispatch(method, params, signal), signal) as Promise<TResponse>
  }

  /**
   * Keep only the stable carrier checks from the pinned package. The generated
   * client also applies the current rc.8 method-value schema here; that makes
   * an rc.6/rc.7 response fail before its version adapter can project it.
   * Domain repositories already validate and narrow each value, so the
   * version-neutral transport must leave `result.value` opaque.
   */
  protected override async callUnary<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
    timeoutPolicy: 'default' | 'caller-signal-only' = 'default',
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const message = {
      type: 'client-request' as const,
      rpcId: this.mintRpcId(),
      method,
      payload,
    }
    this.onEnvelope(message)
    const requestSignal =
      timeoutPolicy === 'caller-signal-only'
        ? signal
        : signal === undefined
          ? AbortSignal.timeout(this.options.requestTimeoutMs)
          : AbortSignal.any([AbortSignal.timeout(this.options.requestTimeoutMs), signal])
    const response = await this.doFetch(new URL(`/api/${method}`, this.options.endpoint.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      ...(requestSignal === undefined ? {} : { signal: requestSignal }),
    })
    if (!response.ok) throw new Error(`transport failure for ${method}: HTTP ${response.status}`)
    let full: ReturnType<typeof serverResponseSchema.parse>
    try {
      full = serverResponseSchema.parse(await response.json())
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a malformed response for ${method}.`,
        retryable: false,
        cause,
      })
    }
    this.onEnvelope(full)
    if (full.rpcId !== message.rpcId)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a mismatched response for ${method}.`,
        retryable: false,
      })
    return { rpcId: full.rpcId, result: full.result as RpcResponse<ResponseValue<K>>['result'] }
  }

  public remoteRequest<TResponse>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    if (this.isClosed)
      return Promise.reject(
        new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'The DSH connection is closed.',
          retryable: true,
        }),
      )
    return this.withRetry(
      endpoint,
      () => this.dispatchRemote<TResponse>(endpoint, args, signal),
      signal,
    ) as Promise<TResponse>
  }

  public openEventStream(signal?: AbortSignal): AsyncIterable<unknown> {
    return this.openMuxStream(mergeSignals(signal, this.closed.signal))
  }

  public openMuxStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.openWebSocketStream(
      '/api/events.mux',
      mergeSignals(signal, this.closed.signal),
      muxFrameSchema,
    )
  }

  public openHostStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.openWebSocketStream(
      '/api/events.host',
      mergeSignals(signal, this.closed.signal),
      hostFrameSchema,
    )
  }

  public respondEnvelope(rpcId: string, result: unknown, signal?: AbortSignal): Promise<unknown> {
    const message: ClientResponse = {
      type: 'client-response',
      rpcId: RpcId(rpcId),
      result: result as RpcResult<unknown>,
    }
    return super.respond(message, signal)
  }

  public async downloadSessionLog(
    sessionId: string,
    includeDescendants: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    const target = new URL('/api/session.export', this.options.endpoint.baseUrl)
    target.searchParams.set('sessionId', sessionId)
    target.searchParams.set('includeDescendants', String(includeDescendants))
    const response = await this.doFetch(target, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok)
      throw new AppError({
        code: 'EXPORT_FAILED',
        message: 'DSH did not return the session export.',
        retryable: true,
        context: { status: response.status },
      })
    return response
  }

  public close(): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    this.isClosed = true
    this.closed.abort()
    return Promise.resolve()
  }

  private async dispatch(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    switch (method) {
      case 'session.list':
        return this.sessions.list(params as RequestPayload<'session.list'>, signal)
      case 'session.search':
        return this.sessions.search(params as RequestPayload<'session.search'>, signal)
      case 'session.create':
        return this.sessions.create(params as RequestPayload<'session.create'>, signal)
      case 'session.history':
        return this.sessions.history(params as RequestPayload<'session.history'>, signal)
      case 'session.models':
        return this.sessions.models(params as RequestPayload<'session.models'>, signal)
      case 'session.selectModel':
        return this.sessions.selectModel(params as RequestPayload<'session.selectModel'>, signal)
      case 'session.rename':
        return this.sessions.rename(params as RequestPayload<'session.rename'>, signal)
      case 'session.fork':
        return this.sessions.fork(params as RequestPayload<'session.fork'>, signal)
      case 'session.prompt':
        return this.sessions.prompt(params as RequestPayload<'session.prompt'>, signal)
      case 'session.attachment':
        return this.sessions.attachment(params as RequestPayload<'session.attachment'>, signal)
      case 'session.updateQueue':
        return this.sessions.updateQueue(params as RequestPayload<'session.updateQueue'>, signal)
      case 'session.cancel':
        return this.sessions.cancel(params as RequestPayload<'session.cancel'>, signal)
      case 'subagent.list':
        return this.subagents.list(params as RequestPayload<'subagent.list'>, signal)
      case 'subagent.history':
        return this.subagents.history(params as RequestPayload<'subagent.history'>, signal)
      case 'subagent.prompt':
        return this.subagents.prompt(params as RequestPayload<'subagent.prompt'>, signal)
      case 'subagent.interrupt':
        return this.subagents.interrupt(params as RequestPayload<'subagent.interrupt'>, signal)
      case 'host.describe':
        // rc.8 made `home` required in the generated response schema. Keep
        // this one handshake call at the wire-envelope level so rc.6 hosts
        // that legitimately omit the new field can still be detected and
        // served by the legacy adapter.
        return this.dispatchHostDescribe(params as RequestPayload<'host.describe'>, signal)
      case 'host.pickDirectory':
        return this.host.pickDirectory(params as RequestPayload<'host.pickDirectory'>, signal)
      case 'host.listDirectory':
        return this.host.listDirectory(params as RequestPayload<'host.listDirectory'>, signal)
      case 'host.createDirectory':
        return this.host.createDirectory(params as RequestPayload<'host.createDirectory'>, signal)
      case 'host.openPath':
        return this.host.openPath(params as RequestPayload<'host.openPath'>, signal)
      case 'workspace.list':
        return this.workspace.list(params as RequestPayload<'workspace.list'>, signal)
      case 'workspace.create':
        return this.workspace.create(params as RequestPayload<'workspace.create'>, signal)
      case 'workspace.rename':
        return this.workspace.rename(params as RequestPayload<'workspace.rename'>, signal)
      case 'workspace.delete':
        return this.workspace.delete(params as RequestPayload<'workspace.delete'>, signal)
      case 'workspace.insertBefore':
        return this.workspace.insertBefore(params as RequestPayload<'workspace.insertBefore'>, signal)
      case 'workspace.insertSessionBefore':
        return this.workspace.insertSessionBefore(
          params as RequestPayload<'workspace.insertSessionBefore'>,
          signal,
        )
      case 'workspace.archiveSession':
        return this.workspace.archiveSession(params as RequestPayload<'workspace.archiveSession'>, signal)
      case 'skill.list':
        return this.skills.list(params as RequestPayload<'skill.list'>, signal)
      case 'agentPreset.list':
        return this.agentPresets.list(params as RequestPayload<'agentPreset.list'>, signal)
      case 'agentPreset.select':
        return this.agentPresets.select(params as RequestPayload<'agentPreset.select'>, signal)
      case 'agentPreset.read':
        return this.agentPresets.read(params as RequestPayload<'agentPreset.read'>, signal)
      case 'agentPreset.copy':
        return this.agentPresets.copy(params as RequestPayload<'agentPreset.copy'>, signal)
      case 'agentPreset.openDocument':
        return this.agentPresets.openDocument(params as RequestPayload<'agentPreset.openDocument'>, signal)
      case 'agentPreset.remove':
        return this.agentPresets.remove(params as RequestPayload<'agentPreset.remove'>, signal)
      case 'goal.create':
        return this.goals.create(params as RequestPayload<'goal.create'>, signal)
      case 'goal.edit':
        return this.goals.edit(params as RequestPayload<'goal.edit'>, signal)
      case 'goal.pause':
        return this.goals.pause(params as RequestPayload<'goal.pause'>, signal)
      case 'goal.resume':
        return this.goals.resume(params as RequestPayload<'goal.resume'>, signal)
      case 'goal.complete':
        return this.goals.complete(params as RequestPayload<'goal.complete'>, signal)
      case 'goal.clear':
        return this.goals.clear(params as RequestPayload<'goal.clear'>, signal)
      case 'settings.describe':
        return this.settings.describe(params as RequestPayload<'settings.describe'>, signal)
      case 'settings.openDocument':
        return this.settings.openDocument(params as RequestPayload<'settings.openDocument'>, signal)
      case 'settings.update':
        return this.settings.update(params as RequestPayload<'settings.update'>, signal)
      case 'settings.replace':
        return this.settings.replace(params as RequestPayload<'settings.replace'>, signal)
      case 'settings.mutate':
        return this.settings.mutate(params as RequestPayload<'settings.mutate'>, signal)
      case 'credentials.describe':
        return this.credentials.describe(params as RequestPayload<'credentials.describe'>, signal)
      case 'credentials.set':
        return this.credentials.set(params as RequestPayload<'credentials.set'>, signal)
      case 'credentials.unset':
        return this.credentials.unset(params as RequestPayload<'credentials.unset'>, signal)
      case 'llm.providers':
        return this.llm.providers(params as RequestPayload<'llm.providers'>, signal)
      case 'llm.models':
        return this.llm.models(params as RequestPayload<'llm.models'>, signal)
      case 'llm.discoverModels':
        return this.llm.discoverModels(params as RequestPayload<'llm.discoverModels'>, signal)
      default:
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: `The connected DSH does not expose ${method}.`,
          retryable: false,
        })
    }
  }

  /**
   * Read the handshake envelope without applying rc.8's generated host schema.
   * The adapter performs the version-specific field checks after this method
   * returns, which is what lets an rc.6 host omit fields introduced later.
   */
  private async dispatchHostDescribe(
    params: RequestPayload<'host.describe'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const message = {
      type: 'client-request' as const,
      rpcId: this.mintRpcId(),
      method: 'host.describe',
      payload: params,
    }
    this.onEnvelope(message)
    const requestSignal =
      signal === undefined
        ? AbortSignal.timeout(this.options.requestTimeoutMs)
        : AbortSignal.any([AbortSignal.timeout(this.options.requestTimeoutMs), signal])
    const response = await this.doFetch(new URL('/api/host.describe', this.options.endpoint.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: requestSignal,
    })
    if (!response.ok)
      throw new AppError({
        code: response.status >= 500 ? 'BACKEND_UNREACHABLE' : 'CAPABILITY_UNAVAILABLE',
        message: `The DSH host.describe endpoint failed (HTTP ${response.status}).`,
        retryable: response.status >= 500,
      })
    let full: ReturnType<typeof serverResponseSchema.parse>
    try {
      full = serverResponseSchema.parse(await response.json())
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned a malformed host.describe response.',
        retryable: false,
        cause,
      })
    }
    this.onEnvelope(full)
    if (full.rpcId !== message.rpcId)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned a mismatched host.describe response.',
        retryable: false,
      })
    return { rpcId: full.rpcId, result: full.result }
  }

  /**
   * Typert Remote calls use the same JSON RPC envelope as the Host API, but
   * their payload is the gateway's exact `{ args }` object.  Keeping this
   * carrier in the Extension Host preserves the Webview boundary and avoids
   * treating a command as a model prompt.
   */
  private async dispatchRemote<TResponse>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    // Typert namespaces are JavaScript identifiers, not lower-case slugs.
    // rc.8 exposes `messageFeedback/...` and `sessionReferenceResolver/...`;
    // rejecting their capital letters turns a valid Remote call into the
    // misleading INVALID_CONFIGURATION error before it reaches DSH.
    if (!/^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]*$/u.test(endpoint))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH Remote endpoint is invalid.',
        retryable: false,
      })
    const message = {
      type: 'client-request' as const,
      rpcId: this.mintRpcId(),
      method: endpoint,
      payload: { args },
    }
    this.onEnvelope(message)
    const target = new URL(`/api/${endpoint}`, this.options.endpoint.baseUrl)
    const response = await this.doFetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok)
      throw new AppError({
        code: response.status >= 500 ? 'BACKEND_UNREACHABLE' : 'CAPABILITY_UNAVAILABLE',
        message: `The DSH Remote endpoint ${endpoint} failed (HTTP ${response.status}).`,
        retryable: response.status >= 500,
        context: { endpoint, status: response.status },
      })
    let full: ReturnType<typeof serverResponseSchema.parse>
    try {
      full = serverResponseSchema.parse(await response.json())
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a malformed Remote response for ${endpoint}.`,
        retryable: false,
        cause,
      })
    }
    this.onEnvelope(full)
    if (full.rpcId !== message.rpcId)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a mismatched Remote response for ${endpoint}.`,
        retryable: false,
      })
    return full.result as TResponse
  }

  private openWebSocketStream(
    path: string,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): unknown },
  ): AsyncIterable<unknown> {
    return this.readWebSocket(path, signal, frameSchema)
  }

  /**
   * DSH exposes event paths as read-only WebSocket downlinks. A normal fetch
   * is intentionally rejected by DSH with HTTP 426, so keep the upgrade and
   * frame decoding here instead of leaking a transport detail upward.
   */
  private async *readWebSocket(
    path: string,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): unknown },
  ): AsyncIterable<unknown> {
    if (signal.aborted) return
    const WebSocketConstructor = this.options.webSocket ?? globalThis.WebSocket
    if (typeof WebSocketConstructor !== 'function')
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The Extension Host does not provide WebSocket transport.',
        retryable: true,
      })

    const target = new URL(path, this.options.endpoint.baseUrl)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocketConstructor(target.toString())
    const inbox = new WebSocketQueue(256)
    let wake: (() => void) | undefined
    let resolveOpen: (() => void) | undefined
    let rejectOpen: ((error: unknown) => void) | undefined
    let openSettled = false
    const opened = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve
      rejectOpen = reject
    })
    const enqueue = (item: WebSocketItem): void => {
      if (!inbox.push(item)) {
        inbox.clear()
        inbox.push({
          kind: 'error',
          error: new AppError({
            code: 'PROTOCOL_ERROR',
            message: 'The DSH event stream exceeded its receive queue limit.',
            retryable: true,
          }),
        })
        try {
          socket.close()
        } catch {
          /* close is best effort after overflow */
        }
      }
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => {
      if (openSettled) return
      openSettled = true
      resolveOpen?.()
    }
    const handleMessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) {
        const error = new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'The DSH event stream returned an invalid frame.',
          retryable: true,
        })
        if (!openSettled) {
          openSettled = true
          rejectOpen?.(error)
        } else enqueue({ kind: 'error', error })
        return
      }
      try {
        const full = serverRequestSchema.parse(JSON.parse(event.data))
        const frame = frameSchema.parse(full.payload)
        this.onEnvelope(full)
        enqueue({ kind: 'frame', value: { rpcId: full.rpcId, payload: frame } })
      } catch {
        const error = new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'The DSH event stream returned a malformed frame.',
          retryable: true,
        })
        if (!openSettled) {
          openSettled = true
          rejectOpen?.(error)
        } else enqueue({ kind: 'error', error })
      }
    }
    const handleError = (): void => {
      const error = new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The DSH event stream transport failed.',
        retryable: true,
      })
      if (!openSettled) {
        openSettled = true
        rejectOpen?.(error)
      } else if (!signal.aborted) enqueue({ kind: 'error', error })
    }
    const handleClose = (): void => {
      if (!openSettled) {
        openSettled = true
        rejectOpen?.(
          new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'The DSH event stream closed before it became ready.',
            retryable: true,
          }),
        )
      } else enqueue({ kind: 'end' })
    }
    const handleAbort = (): void => {
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close()
      } finally {
        enqueue({ kind: 'end' })
      }
    }

    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('error', handleError)
    socket.addEventListener('close', handleClose, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (socket.readyState === 1) handleOpen()
    if (signal.aborted) handleAbort()
    try {
      try {
        await withTimeout(opened, 5_000, signal)
      } catch (error) {
        if (signal.aborted) return
        throw error
      }
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          if (signal.aborted) return
          yield item.value
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    } finally {
      signal.removeEventListener('abort', handleAbort)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('error', handleError)
      socket.removeEventListener('close', handleClose)
      try {
        if (socket.readyState === 0 || socket.readyState === 1) socket.close()
      } catch {
        /* disposal is best effort after an aborted or failed handshake */
      }
    }
  }

  private async withRetry(
    method: string,
    operation: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const attempts = IDEMPOTENT_METHODS.has(method)
      ? Math.max(1, this.options.retryPolicy.maximumAttempts)
      : 1
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal?.aborted === true) throw cancelled(signal.reason)
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt + 1 >= attempts) throw error
        await delay(
          Math.min(
            this.options.retryPolicy.maximumDelayMs,
            this.options.retryPolicy.baseDelayMs * 2 ** attempt,
          ),
          signal,
        )
      }
    }
    throw lastError
  }
}

type WebSocketItem =
  | { readonly kind: 'frame'; readonly value: unknown }
  | { readonly kind: 'end' }
  | { readonly kind: 'error'; readonly error: Error }

class WebSocketQueue {
  private readonly values: (WebSocketItem | undefined)[] = []
  private head = 0

  public constructor(private readonly capacity: number) {}

  public get length(): number {
    return this.values.length - this.head
  }

  public push(value: WebSocketItem): boolean {
    if (this.length >= this.capacity) return false
    this.values.push(value)
    return true
  }

  public shift(): WebSocketItem {
    const value = this.values[this.head]
    this.values[this.head] = undefined
    this.head += 1
    if (this.head > 32 && this.head * 2 > this.values.length) {
      this.values.splice(0, this.head)
      this.head = 0
    }
    return value as WebSocketItem
  }

  public clear(): void {
    this.values.length = 0
    this.head = 0
  }
}

const IDEMPOTENT_METHODS = new Set([
  'host.describe',
  'session.list',
  'session.search',
  'session.history',
  'session.attachment',
  'session.models',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'llm.providers',
  'llm.models',
  'settings.describe',
  'credentials.describe',
  'subagent.list',
  'subagent.history',
  'commands/list',
])

/**
 * rc.6/rc.7 still emit the settings-not-exposed error branch that rc.8
 * removed from its generated envelope schema. Keep the current upstream
 * typed client for every success/value schema, but widen this one legacy
 * error at the transport seam so an older host is not rejected before the
 * adapter's own error mapper sees it.
 */
async function normalizeLegacyRpcResponse(response: Response): Promise<Response> {
  if (!response.headers.get('content-type')?.toLocaleLowerCase().includes('json')) return response
  let value: unknown
  try {
    value = await response.clone().json()
  } catch {
    return response
  }
  if (!isLegacySettingsErrorEnvelope(value)) return response
  const envelope = value as Record<string, unknown>
  const result = envelope.result as Record<string, unknown>
  const error = result.error as Record<string, unknown>
  const normalized = {
    ...envelope,
    result: {
      ...result,
      error: { ...error, code: 'settings-rejected' },
    },
  }
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isLegacySettingsErrorEnvelope(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const envelope = value as Record<string, unknown>
  const result = envelope.result
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const resultRecord = result as Record<string, unknown>
  const error = resultRecord.error
  if (resultRecord.ok !== false || typeof error !== 'object' || error === null || Array.isArray(error))
    return false
  const errorRecord = error as Record<string, unknown>
  const details = errorRecord.details
  return (
    errorRecord.code === 'settings-not-exposed' &&
    typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details) &&
    typeof (details as Record<string, unknown>).ns === 'string'
  )
}

function assertLoopback(endpoint: BackendEndpoint): void {
  if (
    (endpoint.host !== '127.0.0.1' && endpoint.host !== 'localhost') ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    endpoint.baseUrl !== `http://${endpoint.host}:${endpoint.port}`
  ) {
    throw new AppError({
      code: 'INVALID_ENDPOINT',
      message: 'DSH connections must use a validated loopback endpoint.',
      retryable: false,
    })
  }
}

function mergeSignals(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  return first === undefined || first === null ? second : AbortSignal.any([first, second])
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw cancelled(signal.reason)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onAbort = (): void => finish(() => reject(cancelled(signal?.reason)))
    const timer = setTimeout(() => finish(resolve), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'The DSH event stream did not become ready.',
            retryable: true,
          }),
        ),
      timeoutMs,
    )
    const onAbort = (): void => finish(undefined, cancelled(signal?.reason))
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(value as T)
      else
        reject(error instanceof Error ? error : new Error('The DSH transport returned an unspecified error.'))
    }
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    )
  })
}

function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH request was cancelled.',
    retryable: true,
    cause,
  })
}
