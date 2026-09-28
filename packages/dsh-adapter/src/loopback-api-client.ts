import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import type { RequestPayload, ResponseValue, RpcMethodMap } from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import {
  RpcId,
  type ClientResponse,
  type RpcMessage,
  type RpcResponse,
  type RpcResult,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { AppError, type BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport, RetryPolicy } from './contracts.js'
import {
  HOST_FRAME_TYPES,
  type LoopbackFrameChannel,
  type LoopbackFrameParser,
  MUX_FRAME_TYPES,
  readLoopbackWebSocket,
} from './loopback-ws-stream.js'
import {
  normalizeLegacyRpcResponse,
  parseRawServerResponse,
  type RawClientRequest,
  type RawServerResponse,
} from './loopback-rpc-envelope.js'
import { httpFailure, normalizeTransportError } from './transport-errors.js'
import {
  assertLoopback,
  closedConnectionError,
  IDEMPOTENT_METHODS,
  mergeSignals,
  releaseUnreadBody,
  withTransportRetry,
} from './transport-internal.js'

export type { LoopbackFrameChannel, LoopbackFrameParser }

export interface LoopbackApiClientOptions {
  readonly endpoint: BackendEndpoint
  readonly requestTimeoutMs: number
  readonly retryPolicy: RetryPolicy
  readonly fetch: typeof globalThis.fetch
  readonly webSocket?: typeof globalThis.WebSocket
  /** Optional exact-version frame contract for an older Host API family. */
  readonly frameParser?: LoopbackFrameParser
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
    if (this.isClosed) throw closedConnectionError()
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
    return normalizeLegacyRpcResponse(response, input.pathname)
  }

  public request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse> {
    if (this.isClosed) return Promise.reject(closedConnectionError())
    return this.withRetry(method, () => this.dispatch(method, params, signal), signal) as Promise<TResponse>
  }

  /**
   * Keep only the stable carrier checks from the pinned package. The generated
   * client also applies the pinned method-value schema here; that makes
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
    const full = await this.callRawUnary(String(method), payload, signal, timeoutPolicy)
    return {
      rpcId: full.rpcId as RpcResponse<ResponseValue<K>>['rpcId'],
      result: full.result as RpcResponse<ResponseValue<K>>['result'],
    }
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
          // Retrying against a closed client can never succeed; keep this
          // permanent so withRetry does not burn its attempts.
          retryable: false,
        }),
      )
    return this.withRetry<TResponse>(
      endpoint,
      () => this.dispatchRemote<TResponse>(endpoint, args, signal),
      signal,
    )
  }

  public openEventStream(signal?: AbortSignal): AsyncIterable<unknown> {
    return this.openMuxStream(mergeSignals(signal, this.closed.signal))
  }

  public openMuxStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.openWebSocketStream(
      '/api/events.mux',
      mergeSignals(signal, this.closed.signal),
      muxFrameSchema,
      MUX_FRAME_TYPES,
      'mux',
    )
  }

  public openHostStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.openWebSocketStream(
      '/api/events.host',
      mergeSignals(signal, this.closed.signal),
      hostFrameSchema,
      HOST_FRAME_TYPES,
      'host',
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
    let response: Response
    try {
      response = await this.doFetch(target, {
        method: 'GET',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw normalizeTransportError('session.export', error, signal)
    }
    if (!response.ok) {
      await releaseUnreadBody(response)
      throw httpFailure('session.export', response.status, 'EXPORT_FAILED')
    }
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
        // rc.8 and later make `home` required in the generated response schema. Keep
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
      case 'command.list':
      case 'command.execute':
        // These are the pre-Remote command methods used by 0.0.1-rc.1/rc.2.
        // They are deliberately kept as opaque RPCs; the legacy repository
        // owns their exact request/result projection.
        return this.callRawUnary(method, params, signal)
      default:
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: `The connected DSH does not expose ${method}.`,
          retryable: false,
        })
    }
  }

  /**
   * Read the handshake envelope without applying the newest generated host schema.
   * The adapter performs the version-specific field checks after this method
   * returns, which is what lets an rc.6 host omit fields introduced later.
   */
  private async dispatchHostDescribe(
    params: RequestPayload<'host.describe'>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const full = await this.callRawUnary('host.describe', params, signal)
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
    // The current contract exposes `messageFeedback/...` and `sessionReferenceResolver/...`;
    // rejecting their capital letters turns a valid Remote call into the
    // misleading INVALID_CONFIGURATION error before it reaches DSH.
    if (!/^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z][A-Za-z0-9_-]*$/u.test(endpoint))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The DSH Remote endpoint is invalid.',
        retryable: false,
      })
    const full = await this.callRawUnary(endpoint, { args }, signal)
    return full.result as TResponse
  }

  /**
   * Validate only the common RPC carrier. Business result schemas belong to
   * the repositories and old releases legitimately use error codes that are
   * absent from the currently installed generated package.
   */
  private async callRawUnary(
    method: string,
    payload: unknown,
    signal?: AbortSignal,
    timeoutPolicy: 'default' | 'caller-signal-only' = 'default',
  ): Promise<RawServerResponse> {
    const message: RawClientRequest = {
      type: 'client-request',
      rpcId: this.mintRpcId(),
      method,
      payload,
    }
    this.onEnvelope(message as unknown as RpcMessage)
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
    if (!response.ok) {
      await releaseUnreadBody(response)
      throw httpFailure(method, response.status)
    }
    let full: RawServerResponse
    try {
      full = parseRawServerResponse(await response.json())
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a malformed response for ${method}.`,
        retryable: false,
        cause,
      })
    }
    this.onEnvelope(full as unknown as RpcMessage)
    if (full.rpcId !== message.rpcId)
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `DSH returned a mismatched response for ${method}.`,
        retryable: false,
      })
    return full
  }

  private openWebSocketStream(
    path: string,
    signal: AbortSignal,
    frameSchema: { parse(value: unknown): unknown },
    knownFrameTypes: ReadonlySet<string>,
    channel: LoopbackFrameChannel,
  ): AsyncIterable<unknown> {
    return readLoopbackWebSocket({
      path,
      signal,
      frameSchema,
      knownFrameTypes,
      channel,
      baseUrl: this.options.endpoint.baseUrl,
      webSocket: this.options.webSocket,
      frameParser: this.options.frameParser,
      onEnvelope: (message) => this.onEnvelope(message),
    })
  }

  private withRetry<T>(method: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withTransportRetry({
      method,
      operation,
      signal,
      retrySignal: mergeSignals(signal, this.closed.signal),
      retryPolicy: this.options.retryPolicy,
      isIdempotent: (candidate) => IDEMPOTENT_METHODS.has(candidate),
      isClosed: () => this.isConnectionClosed(),
    })
  }

  private isConnectionClosed(): boolean {
    return this.isClosed
  }
}
