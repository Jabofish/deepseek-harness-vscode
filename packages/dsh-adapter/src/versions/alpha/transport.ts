import { randomUUID } from 'node:crypto'
import { CordisClientBoundary } from '../alpha162/cordis-boundary.js'

import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { cancelled, httpFailure, normalizeTransportError } from '../../transport-errors.js'
import {
  assertLoopback,
  closedConnectionError as closedError,
  combineSignals,
  isAlphaIdempotentMethod,
  releaseUnreadBody,
  signalIsAborted,
  withTransportRetry,
} from '../../transport-internal.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'
import { Alpha13AssistantStreamProjector, type Alpha13ProjectorOutput } from '../alpha13/session-wire.js'
import { normalizeAlpha162ControlFrame } from '../alpha162/session-control.js'
import { normalizeAlpha171ControlFrame } from '../alpha171/session-control.js'
import { createAlphaLegacyRpc, type AlphaLegacyRpc } from './alpha-legacy-rpc.js'
import {
  AlphaRemoteMux,
  asRecord,
  type AlphaLoopbackApiClientOptions,
  isJsonLike,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPlainRecord,
  isSafeAlphaCursor,
  isSafeAlphaSequence,
  malformedResponse,
  recordOrUndefined,
} from './remote-mux.js'
import {
  alphaEventOutcome,
  alphaSessionList,
  expandHistoryRecords,
  normalizeAlphaEvent,
  validAlphaEventCancel,
  validAlphaEventEmit,
  validAlphaEventReady,
  validAlphaEventWaterfall,
  validAlphaWireEventFrame,
  validAlphaWireSnapshot,
} from './session-wire.js'
import {
  credentialDescribe,
  goalReceipt,
  modelCatalog,
  presetCopyReceipt,
  presetDocument,
} from './model-catalog.js'
import {
  type AlphaResponse,
  type LegacyResponse,
  assertRemoteEndpoint,
  awaitWithSignal,
  mapEmit,
  normalizeAlphaResult,
  stringValue,
  validAlphaResult,
  withoutKey,
  withoutKeys,
} from './transport-support.js'

export type {
  AlphaErrorCodeNormalizer,
  AlphaLoopbackApiClientOptions,
  AlphaPresetWireVersion,
  AlphaSessionControlWireVersion,
  AlphaSessionWireVersion,
  AlphaWebSocket,
  AlphaWebSocketConstructor,
  AlphaWorkspaceWireVersion,
} from './remote-mux.js'

/**
 * Shared transport for the 0.1.2 alpha Connection/Gateway protocol.
 *
 * The published rc adapters intentionally remain on the generated
 * host-apiproxy client. This class owns the alpha protocol's `/api` path,
 * `{args}` Remote payload, Cookie-authenticated `remote.mux`, and the small
 * compatibility projection consumed by the existing repositories.
 */
export class AlphaLoopbackApiClient implements DshTransport {
  private readonly cordisBoundary = new CordisClientBoundary()
  private readonly closed = new AbortController()
  private readonly remoteMux: AlphaRemoteMux
  private readonly legacyRpc: AlphaLegacyRpc
  private isClosed = false

  public readonly sessionHistoryTurnWindow: boolean

  public constructor(private readonly options: AlphaLoopbackApiClientOptions) {
    assertLoopback(options.endpoint)
    this.sessionHistoryTurnWindow = options.sessionHistoryTurnWindow === true
    this.remoteMux = new AlphaRemoteMux(options)
    this.legacyRpc = createAlphaLegacyRpc({
      options: this.options,
      post: (endpoint, payload, signal) => this.post(endpoint, payload, signal),
      unary: (endpoint, payload, signal) => this.unary(endpoint, payload, signal),
      openRemoteStream: (endpoint, args, signal) => this.openRemoteStream(endpoint, args, signal),
      sessionAddress: (sessionId) => this.sessionAddress(sessionId),
      isClosed: () => this.isClosed,
    })
  }

  public request<TResponse>(method: string, params: unknown, signal?: AbortSignal): Promise<TResponse> {
    if (this.isClosed) return Promise.reject(closedError())
    return this.withRetry(method, () => this.dispatch(method, params, signal), signal) as Promise<TResponse>
  }

  public remoteRequest<TResponse>(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    if (this.isClosed) return Promise.reject(closedError())
    assertRemoteEndpoint(endpoint)
    return this.withRetry(
      endpoint,
      async () => {
        const response = await this.post(endpoint, { args }, signal)
        return response.result as TResponse
      },
      signal,
    )
  }

  /** Fixed read-only routes; never accepts a caller-provided URL. */
  public async readChanges(
    kind: 'summary' | 'diff',
    sessionId: string,
    sequence: number,
    index?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.isClosed) throw closedError()
    const target = new URL(`/api/changes.${kind}`, this.options.endpoint.baseUrl)
    target.searchParams.set('sessionId', sessionId)
    target.searchParams.set('seq', String(sequence))
    if (index !== undefined) target.searchParams.set('index', String(index))
    const cookie = this.options.authCookie?.(this.options.endpoint)
    const cancellationSignal = combineSignals(signal, this.closed.signal)
    const requestSignal = combineSignals(
      cancellationSignal,
      AbortSignal.timeout(this.options.requestTimeoutMs),
    )
    try {
      requestSignal.throwIfAborted()
      const response = await this.options.fetch(target, {
        method: 'GET',
        redirect: 'error',
        signal: requestSignal,
        headers: cookie === undefined ? {} : { Cookie: cookie },
      })
      if (!response.ok) {
        await releaseUnreadBody(response)
        if (response.status === 404) return undefined
        throw httpFailure('workspace changes', response.status)
      }
      const reader = response.body?.getReader()
      if (reader === undefined) throw malformedResponse('workspace changes')
      let text = ''
      let size = 0
      const decoder = new TextDecoder()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > 8 * 1024 * 1024) throw malformedResponse('workspace changes size')
          text += decoder.decode(chunk.value, { stream: true })
        }
        requestSignal.throwIfAborted()
        try {
          return JSON.parse(text + decoder.decode()) as unknown
        } catch (error) {
          throw malformedResponse('workspace changes', error)
        }
      } finally {
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      throw normalizeTransportError(
        'workspace changes',
        requestSignal.aborted ? requestSignal.reason : error,
        cancellationSignal,
      )
    }
  }

  /** Download the exact Host-owned ZIP route retained by the alpha build. */
  public async downloadSessionLog(
    sessionId: string,
    includeDescendants: boolean,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.isClosed) throw closedError()
    const target = new URL('/api/session.export', this.options.endpoint.baseUrl)
    target.searchParams.set('sessionId', stringValue(sessionId, 'session.export sessionId'))
    target.searchParams.set('includeDescendants', String(includeDescendants))
    const cookie = this.options.authCookie?.(this.options.endpoint)
    const headers: Record<string, string> = {}
    if (cookie !== undefined && cookie.trim() !== '') headers.Cookie = cookie
    // This route streams an archive whose size, and therefore duration, grows
    // with the session, so the per-request RPC budget is the wrong bound: it
    // aborts a download the Host is still deflating and reports it as a
    // timeout. The caller's signal stays the deadline (the export is cancelled
    // from the UI), and closing the connection aborts the stream.
    const requestSignal = combineSignals(signal, this.closed.signal)
    let response: Response
    try {
      response = await this.options.fetch(target, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: requestSignal,
      })
    } catch (error) {
      throw normalizeTransportError('session.export', error, signal)
    }
    if (!response.ok) {
      await releaseUnreadBody(response)
      throw httpFailure('session.export', response.status)
    }
    return response
  }

  /** `$events` is projected to the old host-event frames in the alpha seam. */
  public openEventStream(signal?: AbortSignal): AsyncIterable<unknown> {
    return this.readEvents(signal)
  }

  /** `session/control` replaces the old `/api/events.host` downlink. */
  public openHostStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.readControl(signal)
  }

  /** Logical durable session stream used by the alpha event source. */
  public openSessionStream(sessionId: string, signal: AbortSignal): AsyncIterable<unknown> {
    return this.readSession(sessionId, signal)
  }

  /** Logical Workspace projection stream used by the alpha event source. */
  public openWorkspaceStream(signal: AbortSignal): AsyncIterable<unknown> {
    return this.readWorkspace(signal)
  }

  public async respondEnvelope(rpcId: string, result: unknown, signal?: AbortSignal): Promise<unknown> {
    const cordisReceipt = await this.cordisBoundary.respond(
      rpcId,
      result,
      (requestId, requestSignal) =>
        this.unary(
          'dynamicCordisRunner/resolveRequestRun',
          {
            requestId,
            resolution: { ok: false, reason: 'rejected' },
          },
          requestSignal,
        ),
      signal,
    )
    if (cordisReceipt !== undefined) return cordisReceipt
    const pending = this.pendingEvents.get(rpcId)
    if (pending === undefined || pending.clientId !== this.eventClientId)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The DSH interaction stream is no longer active.',
        retryable: true,
      })
    const outcome = alphaEventOutcome(result, pending.kind)
    const response = await this.post(
      '$events/result',
      { args: { clientId: pending.clientId, eventId: rpcId, outcome } },
      signal,
    )
    if (!response.result.ok)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The DSH interaction response was rejected.',
        retryable: true,
        context: { rpcCode: response.result.error.code },
      })
    this.pendingEvents.delete(rpcId)
    return { accepted: true }
  }

  /**
   * Wait until `$events` has accepted this client's Remote Event subscription.
   * The permission catalog is not replayed, so its first read must follow the
   * listener registration represented by the `ready` item.
   */
  public async waitForEventStreamReady(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw cancelled(signal.reason)
    if (this.isClosed) throw closedError()
    if (this.eventClientId !== undefined) return

    let waiter!: { readonly resolve: () => void; readonly reject: (error: unknown) => void }
    const ready = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject }
    })
    this.eventReadyWaiters.add(waiter)
    const timeoutSignal = AbortSignal.timeout(this.options.requestTimeoutMs)
    const waitingSignal = combineSignals(signal, this.closed.signal, timeoutSignal)
    try {
      await awaitWithSignal(ready, waitingSignal)
    } catch (error) {
      // Caller cancellation takes precedence over a stream or timeout failure,
      // matching the other Alpha transport operations.
      if (signalIsAborted(signal)) throw cancelled(signal?.reason)
      if (signalIsAborted(this.closed.signal)) throw closedError()
      if (signalIsAborted(timeoutSignal)) throw normalizeTransportError('$events ready', timeoutSignal.reason)
      throw error
    } finally {
      // A cancelled read must not retain a waiter until a future generation.
      if (this.eventReadyWaiters.delete(waiter)) waiter.reject(cancelled(waitingSignal.reason))
    }
  }

  public async close(): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    this.isClosed = true
    this.closed.abort()
    this.cordisBoundary.clear()
    await this.remoteMux.close()
  }

  private readonly pendingEvents = new Map<
    string,
    { readonly clientId: string; readonly kind: 'approval' | 'question'; readonly sessionId: string }
  >()
  private readonly eventReadyWaiters = new Set<{
    readonly resolve: () => void
    readonly reject: (error: unknown) => void
  }>()
  private eventClientId: string | undefined
  private eventStreamGeneration = 0

  private async dispatch(method: string, params: unknown, signal?: AbortSignal): Promise<LegacyResponse> {
    const value = asRecord(params)
    switch (method) {
      case 'session.list':
        return this.legacyRpc.legacy('session/list', { _request: value }, signal, alphaSessionList)
      case 'session.search':
        return this.legacyRpc.legacy('session/search', { request: value }, signal)
      case 'session.create':
        return this.legacyRpc.legacy(
          'session/create',
          { request: withoutKey(value, 'reuseWorkspaceBlank') },
          signal,
        )
      case 'session.selectModel':
        return this.legacyRpc.legacy('session/selectModel', { request: value }, signal)
      case 'session.rename':
        return this.legacyRpc.legacy('session/rename', { request: value }, signal)
      case 'session.fork':
        return this.legacyRpc.legacy('session/fork', { request: value }, signal)
      case 'session.prompt':
        return this.legacyRpc.prompt(value, signal)
      case 'session.attachment':
        return this.legacyRpc.legacy('session/attachment', { request: value }, signal)
      case 'session.updateQueue':
        return this.legacyRpc.legacy('session/updateQueue', { request: value }, signal)
      case 'session.cancel':
        return this.legacyRpc.legacy('session/cancel', { request: value }, signal)
      case 'session.history':
        return this.legacyRpc.history(value, signal)
      case 'session.models':
        return this.legacyRpc.sessionModels(value, signal)
      case 'subagent.list':
        return this.legacyRpc.legacy('subagents/list', { parentSessionId: value.parentSessionId }, signal)
      case 'subagent.history':
        return this.legacyRpc.subagentHistory(value, signal)
      case 'subagent.prompt':
        return this.legacyRpc.legacy(
          'subagents/prompt',
          {
            request: {
              ...value,
              requestId: typeof value.requestId === 'string' ? value.requestId : randomUUID(),
            },
          },
          signal,
        )
      case 'subagent.interrupt':
        return this.legacyRpc.legacy('subagents/interruptByParent', value, signal)
      case 'host.pickDirectory':
        return this.legacyRpc.legacy('directoryPicker/pick', {}, signal, (result) => ({ path: result }))
      case 'host.listDirectory':
        return this.legacyRpc.legacy('directoryPicker/list', { path: value.path }, signal)
      case 'host.createDirectory':
        return this.legacyRpc.legacy(
          'directoryPicker/createDirectory',
          { path: value.path, name: value.name },
          signal,
          (result) => ({ path: result }),
        )
      case 'host.openPath':
        return this.legacyRpc.legacy('session/openWorkspacePath', { request: { path: value.path } }, signal)
      case 'workspace.list':
        return this.legacyRpc.workspaceList(signal)
      case 'workspace.create':
      case 'workspace.rename':
      case 'workspace.delete':
      case 'workspace.insertBefore':
      case 'workspace.insertSessionBefore':
      case 'workspace.archiveSession':
      case 'workspace.unarchiveSession':
        // Archive and restore differ only in direction: both take `{sessionId}`
        // and answer the complete archive set this registry now holds.
        return this.legacyRpc.legacy(
          `workspace/${method.slice('workspace.'.length)}`,
          { request: value },
          signal,
        )
      case 'skill.list':
        return this.legacyRpc.legacy('skills/list', { request: { sessionId: value.sessionId } }, signal)
      case 'agentPreset.list':
        return this.legacyRpc.presetList(signal)
      case 'agentPreset.select':
        return this.legacyRpc.legacy(
          'agentPresets/select',
          { agentId: value.sessionId, agentPreset: value.agentPreset },
          signal,
          (result) => ({ agentPreset: result }),
        )
      case 'agentPreset.read':
        return this.legacyRpc.legacy(
          'agentPresets/read',
          { agentPreset: value.agentPreset },
          signal,
          presetDocument,
        )
      case 'agentPreset.copy':
        return this.legacyRpc.legacy(
          'agentPresets/copy',
          {
            from: value.from,
            id: value.agentPreset,
            ...(value.name === undefined ? {} : { name: value.name }),
          },
          signal,
          (result) => presetCopyReceipt(result, value.agentPreset),
        )
      case 'agentPreset.openDocument':
        return this.legacyRpc.legacy(
          'settings/openAgentPresetDirectory',
          { agentPreset: value.agentPreset },
          signal,
        )
      case 'agentPreset.remove':
        return this.legacyRpc.legacy(
          'agentPresets/deletePreset',
          { id: value.agentPreset },
          signal,
          () => ({}),
        )
      case 'goal.create':
        return this.legacyRpc.legacy(
          'goals/create',
          {
            agentId: value.sessionId,
            request: {
              objective: value.objective,
              ...(value.maxGoalRounds === undefined ? {} : { maxGoalRounds: value.maxGoalRounds }),
            },
          },
          signal,
          goalReceipt,
        )
      case 'goal.edit':
        return this.legacyRpc.legacy(
          'goals/edit',
          {
            agentId: value.sessionId,
            ref: value.ref,
            request: {
              ...(value.objective === undefined ? {} : { objective: value.objective }),
              ...(value.maxGoalRounds === undefined ? {} : { maxGoalRounds: value.maxGoalRounds }),
            },
          },
          signal,
          goalReceipt,
        )
      case 'goal.pause':
      case 'goal.resume':
      case 'goal.complete':
        return this.legacyRpc.legacy(
          `goals/${method.slice('goal.'.length)}`,
          { agentId: value.sessionId, ref: value.ref },
          signal,
          goalReceipt,
        )
      case 'goal.clear':
        return this.legacyRpc.legacy(
          'goals/clear',
          { agentId: value.sessionId, ref: value.ref },
          signal,
          (receipt) => {
            const tombstone = recordOrUndefined(receipt)
            const previous = recordOrUndefined(value.ref)
            if (
              previous === undefined ||
              tombstone?.id !== previous.id ||
              typeof previous.revision !== 'number' ||
              !Number.isSafeInteger(tombstone?.revision) ||
              tombstone?.revision !== previous.revision + 1
            )
              throw malformedResponse('goals/clear tombstone')
            return { cleared: true }
          },
        )
      case 'settings.describe':
        return this.legacyRpc.legacy('settings/describe', {}, signal)
      case 'settings.openDocument':
        return this.legacyRpc.legacy('settings/openSettingsDocument', {}, signal)
      case 'settings.update':
        return this.legacyRpc.legacy('settings/update', value, signal)
      case 'settings.replace':
        return this.legacyRpc.legacy('settings/replace', value, signal)
      case 'settings.mutate':
        return this.legacyRpc.legacy('settings/mutate', value, signal)
      case 'credentials.describe':
        return this.legacyRpc.legacy('credentials/describe', value, signal, credentialDescribe)
      case 'credentials.set':
      case 'credentials.unset':
        // Both alpha credentials writes declare `RemoteResult<void>`, so a
        // committed write answers an `ok` envelope without any `value` member.
        // The shared repository contract reads a credential receipt as an empty
        // object, and only this version knows the receipt rides no value.
        return this.legacyRpc.legacy(method.replace('.', '/'), value, signal, () => ({}))
      case 'llm.providers':
        return this.legacyRpc.providers(signal)
      case 'llm.models':
        return this.legacyRpc.legacy('session/modelCatalog', {}, signal, modelCatalog)
      case 'llm.discoverModels':
        return this.legacyRpc.legacy(
          'llm/discoverModels',
          { settingsNs: value.settingsNs, request: withoutKeys(value, ['settingsNs']) },
          signal,
          (result) => ({ models: result }),
        )
      default:
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: `The connected alpha DSH does not expose ${method}.`,
          retryable: false,
        })
    }
  }

  private async post(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<AlphaResponse> {
    assertRemoteEndpoint(endpoint)
    const rpcId = randomUUID()
    const target = new URL(`/api/${endpoint}`, this.options.endpoint.baseUrl)
    const cookie = this.options.authCookie?.(this.options.endpoint)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (cookie !== undefined && cookie.trim() !== '') headers.Cookie = cookie
    const requestSignal = combineSignals(signal, this.closed.signal, this.options.requestTimeoutMs)
    let response: Response
    try {
      response = await this.options.fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
        redirect: 'error',
        signal: requestSignal,
      })
    } catch (error) {
      throw normalizeTransportError(endpoint, error, signal)
    }
    if (!response.ok) {
      await releaseUnreadBody(response)
      throw httpFailure(endpoint, response.status)
    }
    let decoded: unknown
    try {
      decoded = await response.json()
    } catch (cause) {
      throw malformedResponse(endpoint, cause)
    }
    const envelope = asRecord(decoded)
    if (
      envelope?.type !== 'server-response' ||
      envelope.rpcId !== rpcId ||
      !validAlphaResult(envelope.result)
    )
      throw malformedResponse(endpoint)
    const result = normalizeAlphaResult(envelope.result, this.options.normalizeErrorCode)
    // An `ok` result without `value` is the wire's only representation of a
    // `undefined` business result (JSON cannot carry one). Replacing it with an
    // empty object would erase the difference between "no result" and an empty
    // one, so the absence has to survive to the caller that declared it.
    return { rpcId, result }
  }

  private async unary(
    endpoint: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.post(endpoint, { args: payload }, signal)
    return unwrapRpcResultValue(response.result, endpoint)
  }

  private async *readEvents(signal?: AbortSignal): AsyncGenerator<unknown> {
    const generation = ++this.eventStreamGeneration
    this.eventClientId = undefined
    this.pendingEvents.clear()
    let ready = false
    try {
      for await (const item of this.openRemoteStream('$events', {}, signal)) {
        const frame = asRecord(item)
        if (!ready) {
          if (!validAlphaEventReady(frame)) throw malformedResponse('$events ready')
          this.eventClientId = frame.clientId
          ready = true
          if (this.eventStreamGeneration === generation) {
            for (const waiter of this.eventReadyWaiters) waiter.resolve()
            this.eventReadyWaiters.clear()
          }
          continue
        }
        if (frame?.type === 'ready') throw malformedResponse('$events ready')
        if (frame?.type === 'emit' && validAlphaEventEmit(frame)) {
          const cordisFrames =
            this.options.cordisClientBoundary === true
              ? this.cordisBoundary.map(frame.event, frame.args)
              : undefined
          yield* cordisFrames ?? mapEmit(frame.event, frame.args)
          continue
        }
        if (frame?.type === 'waterfall' && validAlphaEventWaterfall(frame)) {
          const request = frame.request
          if (frame.event === 'approval/request') {
            if (this.eventClientId !== undefined)
              this.pendingEvents.set(frame.eventId, {
                clientId: this.eventClientId,
                kind: 'approval',
                sessionId: frame.agentId,
              })
            yield {
              ...request,
              type: 'approval/requested',
              rpcId: frame.eventId,
              sessionId: frame.agentId,
              approvalId: frame.eventId,
            }
          } else if (frame.event === 'user-questions/request') {
            if (this.eventClientId !== undefined)
              this.pendingEvents.set(frame.eventId, {
                clientId: this.eventClientId,
                kind: 'question',
                sessionId: frame.agentId,
              })
            yield {
              ...request,
              type: 'question/requested',
              rpcId: frame.eventId,
              sessionId: frame.agentId,
            }
          } else throw malformedResponse('$events waterfall')
          continue
        }
        if (frame?.type === 'cancel' && validAlphaEventCancel(frame)) {
          const pending = this.pendingEvents.get(frame.eventId)
          // The cancel frame itself carries only the eventId, but the resolved
          // projection needs the requesting session so replay bookkeeping can
          // clear the matching pending request.
          if (pending?.kind === 'approval')
            yield {
              type: 'approval/resolved',
              sessionId: pending.sessionId,
              approvalId: frame.eventId,
              outcome: 'cancelled',
            }
          if (pending?.kind === 'question')
            yield {
              type: 'question/resolved',
              sessionId: pending.sessionId,
              questionRpcId: frame.eventId,
              outcome: 'cancelled',
            }
          this.pendingEvents.delete(frame.eventId)
          continue
        }
        throw malformedResponse('$events frame')
      }
      if (!ready) throw malformedResponse('$events ready')
    } catch (error) {
      if (!ready && this.eventStreamGeneration === generation) {
        for (const waiter of this.eventReadyWaiters) waiter.reject(error)
        this.eventReadyWaiters.clear()
      }
      throw error
    } finally {
      if (this.eventStreamGeneration === generation) {
        this.eventClientId = undefined
        this.pendingEvents.clear()
      }
    }
  }

  private async *readControl(signal: AbortSignal): AsyncGenerator<unknown> {
    for await (const item of this.openRemoteStream('session/control', {}, signal)) {
      const controlWireVersion = this.options.controlWireVersion ?? 'queue-v1'
      if (controlWireVersion === 'projection-v2') {
        const frames = normalizeAlpha171ControlFrame(item)
        if (frames === undefined) throw malformedResponse('session/control alpha171 frame')
        yield* frames
        continue
      }
      if (controlWireVersion === 'inbox-v1') {
        const frames = normalizeAlpha162ControlFrame(item)
        if (frames === undefined) throw malformedResponse('session/control alpha.2 frame')
        yield* frames
        continue
      }
      const frame = recordOrUndefined(item)
      if (frame?.type === 'baseline') {
        const value = recordOrUndefined(frame.value)
        const queues = value === undefined ? undefined : recordOrUndefined(value.queues)
        const jobs = value === undefined ? undefined : recordOrUndefined(value.jobs)
        const projections = value === undefined ? undefined : recordOrUndefined(value.projections)
        if (
          queues === undefined ||
          jobs === undefined ||
          projections === undefined ||
          !Object.values(queues).every((items) => Array.isArray(items) && items.every(isPlainRecord)) ||
          !Object.values(jobs).every((items) => Array.isArray(items) && items.every(isPlainRecord))
        )
          throw malformedResponse('session/control baseline')
        for (const [sessionId, items] of Object.entries(queues))
          yield { type: 'session/queue', sessionId, items }
        for (const [sessionId, items] of Object.entries(jobs))
          yield { type: 'session/jobs', sessionId, jobs: items }
        for (const [sessionId, projection] of Object.entries(projections)) {
          const block = recordOrUndefined(projection)
          const values = block === undefined ? undefined : recordOrUndefined(block.values)
          if (
            block === undefined ||
            values === undefined ||
            !isSafeAlphaCursor(block.asOfSeq) ||
            !Object.values(values).every((projectionValue) => isJsonLike(projectionValue))
          )
            throw malformedResponse('session/control projection')
          const seq = block.asOfSeq
          for (const [key, projectionValue] of Object.entries(values))
            yield { type: 'session/projection', sessionId, key, value: projectionValue, seq }
        }
        continue
      }
      if (frame?.type === 'queue') {
        if (
          !isNonEmptyString(frame.sessionId) ||
          !Array.isArray(frame.items) ||
          !frame.items.every(isPlainRecord)
        )
          throw malformedResponse('session/control queue')
        yield { type: 'session/queue', sessionId: frame.sessionId, items: frame.items }
      } else if (frame?.type === 'jobs') {
        if (
          !isNonEmptyString(frame.sessionId) ||
          !Array.isArray(frame.jobs) ||
          !frame.jobs.every(isPlainRecord)
        )
          throw malformedResponse('session/control jobs')
        yield { type: 'session/jobs', sessionId: frame.sessionId, jobs: frame.jobs }
      } else if (frame?.type === 'projection') {
        if (
          !isNonEmptyString(frame.sessionId) ||
          !isNonEmptyString(frame.key) ||
          !isSafeAlphaSequence(frame.seq) ||
          !isJsonLike(frame.value)
        )
          throw malformedResponse('session/control projection')
        // Incremental projections carry the cursor they describe, not a durable
        // log position: the same `seq` can also belong to a real event that
        // arrives right after. Re-emit the normalized frame the baseline branch
        // already produces so the seam never consumes a durable slot for it.
        yield {
          type: 'session/projection',
          sessionId: frame.sessionId,
          key: frame.key,
          value: frame.value,
          seq: frame.seq,
        }
      } else {
        throw malformedResponse('session/control frame')
      }
    }
  }

  private async *readSession(sessionId: string, signal: AbortSignal): AsyncGenerator<unknown> {
    const wireVersion = this.options.sessionWireVersion ?? 'v0'
    const v2 = wireVersion === 'v2'
    const assistantStream = v2 || wireVersion === 'v3' || wireVersion === 'v4'
    const historyWindow = this.legacyRpc.historyWindowOptions({
      maxMessages: 50,
      ...(this.options.sessionHistoryTurnWindow === true
        ? { turnWindow: { minMessages: 50, minTurns: 2 } }
        : {}),
    })
    const request = {
      address: this.sessionAddress(sessionId),
      ...historyWindow,
      ...(assistantStream ? { assistantStream: true } : {}),
    }
    const projector = assistantStream ? new Alpha13AssistantStreamProjector() : undefined
    for await (const item of this.openRemoteStream('session/follow', { request }, signal)) {
      const frame = recordOrUndefined(item)
      if (frame?.type === 'snapshot') {
        if (!validAlphaWireSnapshot(frame, wireVersion)) throw malformedResponse('session/follow snapshot')
        let queueFrame: unknown
        if (this.options.normalizeSessionQueueProjection !== undefined) {
          try {
            queueFrame = this.options.normalizeSessionQueueProjection(sessionId, frame.projections)
          } catch (cause) {
            // Validate the projection-derived queue before publishing any part
            // of this snapshot so malformed Inbox state cannot partially
            // advance the transcript or queue baseline.
            throw malformedResponse('session/follow Inbox projection', cause)
          }
        }
        const events = expandHistoryRecords(
          frame.records,
          sessionId,
          wireVersion,
          this.options.autoReviewDenialContract === true,
        )
        if (projector !== undefined) for (const event of events) projector.rememberDurable(event)
        for (const event of events) yield { type: 'session/event', sessionId, event }
        if (queueFrame !== undefined) yield queueFrame
        yield {
          type: 'session/subscribed',
          sessionId,
          lastSeq: frame.cursor,
          // Alpha's Session follow is separate from session/control and
          // $events. A follow reconnect must not reset queue, jobs, or pending
          // interactions that are still owned by those streams.
          controlBaseline: false,
          projections: frame.projections,
        }
        if (projector !== undefined) {
          if (frame.assistantStream === undefined)
            throw malformedResponse('session/follow assistant stream baseline')
          let projected: readonly Alpha13ProjectorOutput[]
          try {
            projected = projector.open(frame.assistantStream, sessionId)
          } catch (cause) {
            throw malformedResponse('session/follow assistant stream baseline', cause)
          }
          for (const output of projected) yield this.alpha13ProjectorFrame(output)
        }
      } else if (frame?.type === 'event') {
        if (!validAlphaWireEventFrame(frame, wireVersion)) throw malformedResponse('session/follow event')
        const event = normalizeAlphaEvent(
          frame.event,
          sessionId,
          wireVersion,
          this.options.autoReviewDenialContract === true,
        )
        if (event === undefined) throw malformedResponse('session/follow event')
        if (projector === undefined) yield { type: 'session/event', sessionId, event }
        else {
          let projected: readonly Alpha13ProjectorOutput[]
          try {
            projected = projector.acceptDurable(event)
          } catch (cause) {
            throw malformedResponse('session/follow assistant settlement', cause)
          }
          for (const output of projected) yield this.alpha13ProjectorFrame(output)
        }
      } else if (projector !== undefined && frame?.type === 'assistant-stream') {
        let projected: readonly Alpha13ProjectorOutput[]
        try {
          projected = projector.acceptFrame(frame.frame, sessionId)
        } catch (cause) {
          throw malformedResponse('session/follow assistant stream frame', cause)
        }
        for (const output of projected) yield this.alpha13ProjectorFrame(output)
      } else throw malformedResponse('session/follow frame')
    }
  }

  /**
   * Address one Session durably. A subagent child must travel through the
   * parent/mode descriptor its catalog published: the Session Controller
   * refuses a session-kind address for a subagent-origin Session, which would
   * otherwise fail the child's live stream and every page read forever.
   */
  private sessionAddress(sessionId: string): Record<string, unknown> {
    const child = this.options.subagentAddresses?.resolve(sessionId)
    if (child === undefined) return { kind: 'session', sessionId }
    return {
      kind: 'subagent',
      parentSessionId: child.parentSessionId,
      childSessionId: sessionId,
      mode: child.mode,
    }
  }

  private alpha13ProjectorFrame(output: Alpha13ProjectorOutput): Record<string, unknown> {
    if (output.type === 'event') {
      const sessionId = output.event.sessionId
      if (typeof sessionId !== 'string' || sessionId.trim() === '')
        throw malformedResponse('session/follow assistant settlement')
      return { type: 'session/event', sessionId, event: output.event }
    }
    if (output.type === 'interrupted')
      return {
        type: 'session/assistant-interrupted',
        sessionId: output.sessionId,
        attemptId: output.attemptId,
        turn: output.turn,
        step: output.step,
      }
    return {
      type: 'session/assistant-stream',
      sessionId: output.sessionId,
      transientSequence: output.transientSequence,
      frame: {
        type: 'chunk',
        attemptId: output.attemptId,
        revision: output.revision,
        index: output.index,
        time: output.time,
        turn: output.turn,
        step: output.step,
        startedAfterSeq: output.startedAfterSeq,
        chunk: output.chunk,
      },
    }
  }

  private async *readWorkspace(signal: AbortSignal): AsyncGenerator<unknown> {
    const pinnedWorkspace = this.options.workspaceWireVersion === 'pinned-v2'
    for await (const item of this.openRemoteStream('workspace/follow', {}, signal)) {
      const frame = recordOrUndefined(item)
      if (frame?.type === 'baseline') {
        const value = recordOrUndefined(frame.value)
        if (
          value === undefined ||
          !Array.isArray(value.items) ||
          !value.items.every(isPlainRecord) ||
          !isNonEmptyStringArray(value.archivedSessionIds) ||
          (pinnedWorkspace && !isNonEmptyStringArray(value.pinnedSessionIds))
        )
          throw malformedResponse('workspace/follow baseline')
        yield { type: 'host/workspace-changed' }
        yield { type: 'host/archived-sessions-changed', sessionIds: value.archivedSessionIds }
        if (pinnedWorkspace)
          yield { type: 'host/pinned-sessions-changed', sessionIds: value.pinnedSessionIds }
      } else if (frame?.type === 'upsert') {
        if (!isPlainRecord(frame.workspace)) throw malformedResponse('workspace/follow upsert')
        yield { type: 'host/workspace-changed', workspace: frame.workspace }
      } else if (frame?.type === 'remove') {
        if (!isNonEmptyString(frame.workspaceId)) throw malformedResponse('workspace/follow remove')
        yield { type: 'host/workspace-removed', workspaceId: frame.workspaceId }
      } else if (frame?.type === 'order') {
        if (!isNonEmptyStringArray(frame.workspaceIds)) throw malformedResponse('workspace/follow order')
        yield { type: 'host/workspace-order-changed', workspaceIds: frame.workspaceIds }
      } else if (frame?.type === 'archived') {
        if (!isNonEmptyStringArray(frame.archivedSessionIds))
          throw malformedResponse('workspace/follow archived')
        yield { type: 'host/archived-sessions-changed', sessionIds: frame.archivedSessionIds }
      } else if (frame?.type === 'pinned') {
        if (!pinnedWorkspace || !isNonEmptyStringArray(frame.pinnedSessionIds))
          throw malformedResponse('workspace/follow pinned')
        yield { type: 'host/pinned-sessions-changed', sessionIds: frame.pinnedSessionIds }
      } else throw malformedResponse('workspace/follow frame')
    }
  }

  public async *openRemoteStream(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    if (this.isClosed) return
    const requestSignal = combineSignals(signal, this.closed.signal)
    for await (const item of this.remoteMux.open(endpoint, args, requestSignal)) yield item
  }

  private withRetry<T>(method: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withTransportRetry({
      method,
      operation,
      signal,
      retrySignal: combineSignals(signal, this.closed.signal),
      retryPolicy: this.options.retryPolicy,
      isIdempotent: isAlphaIdempotentMethod,
      isClosed: () => this.isConnectionClosed(),
    })
  }

  private isConnectionClosed(): boolean {
    return this.isClosed
  }
}
