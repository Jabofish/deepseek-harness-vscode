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
import { projectedModelSelection } from '../../projection/agent.js'
import { Alpha13AssistantStreamProjector, type Alpha13ProjectorOutput } from '../alpha13/session-wire.js'
import { validAlpha151ProjectionBaseline } from '../alpha151/session-wire.js'
import { normalizeAlpha162ControlFrame } from '../alpha162/session-control.js'
import { normalizeAlpha171ControlFrame } from '../alpha171/session-control.js'
import { validAlpha171ProjectionBaseline } from '../alpha171/session-wire.js'
import {
  AlphaRemoteMux,
  asRecord,
  type AlphaErrorCodeNormalizer,
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
  validAlphaProjectionBaseline,
  validAlphaWireEventFrame,
  validAlphaWireSnapshot,
} from './session-wire.js'
import {
  type AlphaCatalogSelection,
  credentialDescribe,
  goalReceipt,
  modelCatalog,
  presetCopyReceipt,
  presetDocument,
  presetRoster,
  validAlphaModelCatalog,
  validAlphaModelSelectionProjection,
} from './model-catalog.js'

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

type AlphaSuccess = { readonly ok: true; readonly value?: unknown }
type AlphaFailure = {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details: Record<string, unknown>
  }
}
type AlphaResult = AlphaSuccess | AlphaFailure
type AlphaResponse = { readonly rpcId: string; readonly result: AlphaResult }
type LegacyResponse = { readonly rpcId: string; readonly result: AlphaResult }

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
  private isClosed = false

  public readonly sessionHistoryTurnWindow: boolean

  public constructor(private readonly options: AlphaLoopbackApiClientOptions) {
    assertLoopback(options.endpoint)
    this.sessionHistoryTurnWindow = options.sessionHistoryTurnWindow === true
    this.remoteMux = new AlphaRemoteMux(options)
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
        return this.legacy('session/list', { _request: value }, signal, alphaSessionList)
      case 'session.search':
        return this.legacy('session/search', { request: value }, signal)
      case 'session.create':
        return this.legacy('session/create', { request: withoutKey(value, 'reuseWorkspaceBlank') }, signal)
      case 'session.selectModel':
        return this.legacy('session/selectModel', { request: value }, signal)
      case 'session.rename':
        return this.legacy('session/rename', { request: value }, signal)
      case 'session.fork':
        return this.legacy('session/fork', { request: value }, signal)
      case 'session.prompt':
        return this.prompt(value, signal)
      case 'session.attachment':
        return this.legacy('session/attachment', { request: value }, signal)
      case 'session.updateQueue':
        return this.legacy('session/updateQueue', { request: value }, signal)
      case 'session.cancel':
        return this.legacy('session/cancel', { request: value }, signal)
      case 'session.history':
        return this.history(value, signal)
      case 'session.models':
        return this.sessionModels(value, signal)
      case 'subagent.list':
        return this.legacy('subagents/list', { parentSessionId: value.parentSessionId }, signal)
      case 'subagent.history':
        return this.subagentHistory(value, signal)
      case 'subagent.prompt':
        return this.legacy(
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
        return this.legacy('subagents/interruptByParent', value, signal)
      case 'host.pickDirectory':
        return this.legacy('directoryPicker/pick', {}, signal, (result) => ({ path: result }))
      case 'host.listDirectory':
        return this.legacy('directoryPicker/list', { path: value.path }, signal)
      case 'host.createDirectory':
        return this.legacy(
          'directoryPicker/createDirectory',
          { path: value.path, name: value.name },
          signal,
          (result) => ({ path: result }),
        )
      case 'host.openPath':
        return this.legacy('session/openWorkspacePath', { request: { path: value.path } }, signal)
      case 'workspace.list':
        return this.workspaceList(signal)
      case 'workspace.create':
      case 'workspace.rename':
      case 'workspace.delete':
      case 'workspace.insertBefore':
      case 'workspace.insertSessionBefore':
      case 'workspace.archiveSession':
      case 'workspace.unarchiveSession':
        // Archive and restore differ only in direction: both take `{sessionId}`
        // and answer the complete archive set this registry now holds.
        return this.legacy(`workspace/${method.slice('workspace.'.length)}`, { request: value }, signal)
      case 'skill.list':
        return this.legacy('skills/list', { request: { sessionId: value.sessionId } }, signal)
      case 'agentPreset.list':
        return this.presetList(signal)
      case 'agentPreset.select':
        return this.legacy(
          'agentPresets/select',
          { agentId: value.sessionId, agentPreset: value.agentPreset },
          signal,
          (result) => ({ agentPreset: result }),
        )
      case 'agentPreset.read':
        return this.legacy('agentPresets/read', { agentPreset: value.agentPreset }, signal, presetDocument)
      case 'agentPreset.copy':
        return this.legacy(
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
        return this.legacy('settings/openAgentPresetDirectory', { agentPreset: value.agentPreset }, signal)
      case 'agentPreset.remove':
        return this.legacy('agentPresets/deletePreset', { id: value.agentPreset }, signal, () => ({}))
      case 'goal.create':
        return this.legacy(
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
        return this.legacy(
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
        return this.legacy(
          `goals/${method.slice('goal.'.length)}`,
          { agentId: value.sessionId, ref: value.ref },
          signal,
          goalReceipt,
        )
      case 'goal.clear':
        return this.legacy('goals/clear', { agentId: value.sessionId, ref: value.ref }, signal, (receipt) => {
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
        })
      case 'settings.describe':
        return this.legacy('settings/describe', {}, signal)
      case 'settings.openDocument':
        return this.legacy('settings/openSettingsDocument', {}, signal)
      case 'settings.update':
        return this.legacy('settings/update', value, signal)
      case 'settings.replace':
        return this.legacy('settings/replace', value, signal)
      case 'settings.mutate':
        return this.legacy('settings/mutate', value, signal)
      case 'credentials.describe':
        return this.legacy('credentials/describe', value, signal, credentialDescribe)
      case 'credentials.set':
      case 'credentials.unset':
        // Both alpha credentials writes declare `RemoteResult<void>`, so a
        // committed write answers an `ok` envelope without any `value` member.
        // The shared repository contract reads a credential receipt as an empty
        // object, and only this version knows the receipt rides no value.
        return this.legacy(method.replace('.', '/'), value, signal, () => ({}))
      case 'llm.providers':
        return this.providers(signal)
      case 'llm.models':
        return this.legacy('session/modelCatalog', {}, signal, modelCatalog)
      case 'llm.discoverModels':
        return this.legacy(
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

  private async legacy(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    transform?: (value: unknown) => unknown,
  ): Promise<LegacyResponse> {
    const response = await this.post(endpoint, { args }, signal)
    if (!response.result.ok || transform === undefined) return response
    try {
      return { ...response, result: { ok: true, value: transform(response.result.value) } }
    } catch (cause) {
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: `The alpha DSH response for ${endpoint} could not be projected.`,
        retryable: false,
        cause,
      })
    }
  }

  private async presetList(signal?: AbortSignal): Promise<LegacyResponse> {
    if (this.options.presetWireVersion === 'registry-v2')
      return this.legacy('agentPresets/list', {}, signal, presetRoster)
    // Alpha keeps the roster and native-opener capability on separate Remote
    // methods. Joining them here prevents `authorable` (a write capability)
    // from being mistaken for the unrelated ability to open a directory.
    const rosterPromise = this.legacy('agentPresets/list', {}, signal, presetRoster)
    const openerPromise = this.legacy('settings/canOpenAgentPresetDirectory', {}, signal).catch(
      (error: unknown) => {
        // The roster is still useful when an optional native opener is not
        // composed or temporarily unavailable. Preserve cancellation and a
        // client close so an in-flight request cannot resolve after teardown.
        if (
          this.isClosed ||
          signal?.aborted === true ||
          (error instanceof AppError && error.code === 'REQUEST_CANCELLED')
        )
          throw error
        return undefined
      },
    )
    const [roster, opener] = await Promise.all([rosterPromise, openerPromise])
    if (!roster.result.ok) return roster
    const value = recordOrUndefined(roster.result.value)
    if (value === undefined) throw malformedResponse('agentPresets/list')
    // An opener probe that did not answer states nothing: return the roster
    // without the capability instead of claiming the host cannot open a
    // directory, so the surface can word the action as unknown rather than
    // offering a native open the deployment may not have.
    if (opener === undefined || !opener.result.ok)
      return { ...roster, result: { ok: true, value: { ...value } } }
    if (typeof opener.result.value !== 'boolean')
      throw malformedResponse('settings/canOpenAgentPresetDirectory')
    return {
      ...roster,
      result: { ok: true, value: { ...value, hasDocument: opener.result.value } },
    }
  }

  /**
   * Alpha publishes the prompt's request id in the queue projection. The
   * legacy repository uses the transport response id for that correlation,
   * so expose the same logical id while keeping the physical Connection
   * envelope id private to `post`.
   */
  private async prompt(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const requestId = isNonEmptyString(value.requestId) ? value.requestId : randomUUID()
    const content: unknown[] = []
    for (const part of Array.isArray(value.content) ? value.content : []) {
      const file = recordOrUndefined(part)
      if (file?.type !== 'file-upload') {
        content.push(part)
        continue
      }
      if (this.options.fileUploads !== true)
        throw new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'This DSH version does not support binary file uploads.',
          retryable: false,
        })
      const receipt = recordOrUndefined(
        await this.unary(
          'fileUploads/upload',
          {
            agentId: stringValue(value.sessionId, 'file upload sessionId'),
            request: {
              data: stringValue(file.data, 'file upload data'),
              name: stringValue(file.name, 'file upload name'),
            },
          },
          signal,
        ),
      )
      const storedFile = recordOrUndefined(receipt?.file)
      if (
        !isNonEmptyString(receipt?.receiptId) ||
        !isNonEmptyString(storedFile?.attachmentId) ||
        typeof storedFile?.name !== 'string' ||
        !Number.isSafeInteger(storedFile.bytes) ||
        (storedFile.bytes as number) < 0
      )
        throw malformedResponse('fileUploads/upload')
      content.push({ type: 'file', receiptId: receipt.receiptId })
    }
    const response = await this.legacy(
      'session/prompt',
      { request: { ...value, content, requestId } },
      signal,
    )
    return { ...response, rpcId: requestId }
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

  private async history(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const sessionId = stringValue(value.sessionId, 'session.history sessionId')
    const address = this.sessionAddress(sessionId)
    const historyWindow = this.historyWindowOptions(value)
    const snapshot = await this.followSnapshot({ address, ...historyWindow }, signal)
    if (value.beforeSeq !== undefined) {
      const page = await this.unary(
        'session/page',
        {
          request: {
            address,
            throughSeq: snapshot.cursor,
            beforeSeq: value.beforeSeq,
            ...historyWindow,
          },
        },
        signal,
      )
      return this.historyResponse(page, sessionId)
    }
    return this.historyResponse(
      { records: snapshot.records, hasMore: snapshot.hasMore, projections: snapshot.projections },
      sessionId,
    )
  }

  private async subagentHistory(
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<LegacyResponse> {
    const sessionId = stringValue(value.childSessionId, 'subagent.history childSessionId')
    const address = {
      kind: 'subagent',
      parentSessionId: stringValue(value.parentSessionId, 'subagent.history parentSessionId'),
      childSessionId: sessionId,
      mode: value.mode === 'one-shot' ? 'one-shot' : 'continuable',
    }
    const historyWindow = this.historyWindowOptions(value)
    const snapshot = await this.followSnapshot({ address, ...historyWindow }, signal)
    const page =
      value.beforeSeq === undefined
        ? { records: snapshot.records, hasMore: snapshot.hasMore, projections: snapshot.projections }
        : await this.unary(
            'session/page',
            {
              request: {
                address,
                throughSeq: snapshot.cursor,
                beforeSeq: value.beforeSeq,
                ...historyWindow,
              },
            },
            signal,
          )
    return this.historyResponse(page, sessionId)
  }

  private historyWindowOptions(value: Record<string, unknown>): Record<string, unknown> {
    const requested = recordOrUndefined(value.turnWindow)
    if (
      this.options.sessionHistoryTurnWindow === true &&
      requested !== undefined &&
      Number.isSafeInteger(requested.minMessages) &&
      (requested.minMessages as number) > 0 &&
      (requested.minMessages as number) <= 500 &&
      Number.isSafeInteger(requested.minTurns) &&
      (requested.minTurns as number) > 0
    ) {
      return {
        maxMessages: 500,
        turnWindow: {
          minMessages: requested.minMessages,
          minTurns: requested.minTurns,
        },
      }
    }
    return value.maxMessages === undefined ? {} : { maxMessages: value.maxMessages }
  }

  private async followSnapshot(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    for await (const item of this.openRemoteStream('session/follow', { request }, signal)) {
      const frame = recordOrUndefined(item)
      if (!validAlphaWireSnapshot(frame, this.options.sessionWireVersion ?? 'v0'))
        throw malformedResponse('session/follow snapshot')
      return frame
    }
    throw malformedResponse('session/follow snapshot')
  }

  private historyResponse(value: unknown, sessionId: string): LegacyResponse {
    const record = recordOrUndefined(value)
    const wireVersion = this.options.sessionWireVersion ?? 'v0'
    if (
      record === undefined ||
      !Array.isArray(record.records) ||
      typeof record.hasMore !== 'boolean' ||
      (record.projections !== undefined &&
        (wireVersion === 'v4'
          ? !validAlpha171ProjectionBaseline(record.projections)
          : wireVersion === 'v3'
            ? !validAlpha151ProjectionBaseline(record.projections)
            : !validAlphaProjectionBaseline(record.projections)))
    )
      throw malformedResponse('session history')
    const events = expandHistoryRecords(
      record.records,
      sessionId,
      wireVersion,
      this.options.autoReviewDenialContract === true,
    )
    return {
      rpcId: randomUUID(),
      result: {
        ok: true,
        value: {
          events: events.map((event) => ({ event })),
          hasMore: record.hasMore,
          ...(record.projections === undefined ? {} : { projections: record.projections }),
        },
      },
    }
  }

  private async sessionModels(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const sessionId = stringValue(value.sessionId, 'session.models sessionId')
    const response = await this.post('session/modelCatalog', { args: {} }, signal)
    if (!response.result.ok) return response
    const catalog = response.result.value
    if (!validAlphaModelCatalog(catalog)) throw malformedResponse('session/modelCatalog')
    // The catalog names the deployment default and every routable provider; it
    // deliberately does not name which of them *this* session uses, because a
    // request's route is durable session state. Read that projection instead of
    // answering about the default: a surface that blocks input on `routable`
    // would otherwise block a session whose own model the host serves, and let
    // through one whose adapter is gone.
    const current = await this.sessionModelSelection(sessionId, catalog.default, signal)
    return {
      ...response,
      result: {
        ok: true,
        value: {
          current,
          routable: catalog.routableProviders.includes(current.provider),
          groups: catalog.groups,
          failures: catalog.failures,
        },
      },
    }
  }

  /**
   * The route this session's next request will take. A session that selected a
   * model (or already sent one) states it in the durable `modelSelection`
   * projection, which the open/history path reads from the same baseline; a
   * session that never did falls back to the deployment default the catalog
   * answered. The projection read is not optional: answering the default under
   * the name of the session's selection is exactly the misstatement above.
   */
  private async sessionModelSelection(
    sessionId: string,
    fallback: AlphaCatalogSelection,
    signal?: AbortSignal,
  ): Promise<AlphaCatalogSelection> {
    const snapshot = await this.followSnapshot({ address: this.sessionAddress(sessionId) }, signal)
    const projections = recordOrUndefined(snapshot.projections)
    const projectionValues = recordOrUndefined(projections?.values)
    if (
      this.options.requireModelSelectionProjection === true &&
      !validAlphaModelSelectionProjection(projectionValues?.modelSelection)
    )
      throw malformedResponse('session modelSelection projection')
    const selected = projectedModelSelection(projectionValues)
    if (selected.providerId === '' || selected.modelId === '') return fallback
    return {
      provider: selected.providerId,
      model: selected.modelId,
      ...(selected.reasoningLevel === undefined ? {} : { reasoningEffort: selected.reasoningLevel }),
    }
  }

  private async providers(signal?: AbortSignal): Promise<LegacyResponse> {
    const [providers, configurable] = await Promise.all([
      this.post('llm/listProviders', { args: {} }, signal),
      this.post('llm/listConfigurableProviders', { args: {} }, signal),
    ])
    if (!providers.result.ok) return providers
    if (!configurable.result.ok) return configurable
    const listed = alphaProviderInfoList(providers.result.value)
    const configs = alphaConfigurableProviderList(configurable.result.value)
    const byProvider = new Map<string, AlphaConfigurableProvider>()
    for (const entry of configs) {
      const row = entry
      if (isNonEmptyString(row.provider)) byProvider.set(row.provider, row)
    }
    const mapped = new Map<string, Record<string, unknown>>()
    for (const entry of listed) {
      const row = entry
      const config = byProvider.get(row.id)
      mapped.set(row.id, {
        provider: row.id,
        displayName: row.name,
        // A live route without a configurable-directory entry has no settings
        // address. Preserve the upstream join contract's empty marker rather
        // than inventing a namespace from the route id; the Webview uses this
        // distinction to avoid hiding a real registered provider.
        settingsNs: config === undefined ? '' : config.settingsNs,
        settingsPath: config?.settingsPath ?? [],
        active: true,
        ...(typeof config?.declared === 'boolean' ? { declared: config.declared } : {}),
      })
    }
    for (const entry of configs) {
      const row = entry
      if (mapped.has(row.provider)) continue
      mapped.set(row.provider, {
        provider: row.provider,
        displayName: row.displayName,
        settingsNs: row.settingsNs,
        settingsPath: row.settingsPath,
        active: false,
        ...(typeof row.declared === 'boolean' ? { declared: row.declared } : {}),
      })
    }
    return {
      rpcId: providers.rpcId,
      result: { ok: true, value: { providers: [...mapped.values()] } },
    }
  }

  private async workspaceList(signal?: AbortSignal): Promise<LegacyResponse> {
    const first = await this.firstStreamItem('workspace/follow', {}, signal)
    const value = recordOrUndefined(first)
    if (value?.type !== 'baseline') throw malformedResponse('workspace/follow baseline')
    const baseline = recordOrUndefined(value.value)
    if (
      baseline === undefined ||
      !Array.isArray(baseline.items) ||
      !baseline.items.every(isPlainRecord) ||
      !isNonEmptyStringArray(baseline.archivedSessionIds) ||
      (this.options.workspaceWireVersion === 'pinned-v2' && !isNonEmptyStringArray(baseline.pinnedSessionIds))
    )
      throw malformedResponse('workspace/follow baseline value')
    return { rpcId: randomUUID(), result: { ok: true, value: baseline } }
  }

  private async unary(
    endpoint: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.post(endpoint, { args: payload }, signal)
    return unwrapRpcResultValue(response.result, endpoint)
  }

  private async firstStreamItem(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for await (const item of this.openRemoteStream(endpoint, args, signal)) return item
    throw malformedResponse(`${endpoint} stream`)
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
    const historyWindow = this.historyWindowOptions({
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

function mapEmit(event: unknown, args: readonly unknown[]): readonly unknown[] {
  switch (event) {
    case 'api-session/added': {
      const summary = recordOrUndefined(args[0])
      if (
        args.length !== 1 ||
        summary === undefined ||
        !isNonEmptyString(summary.sessionId) ||
        typeof summary.blank !== 'boolean' ||
        (summary.parentSessionId !== undefined && !isNonEmptyString(summary.parentSessionId)) ||
        (summary.origin !== undefined && summary.origin !== 'subagent') ||
        (summary.agentAvailable !== undefined && typeof summary.agentAvailable !== 'boolean') ||
        (summary.cwd !== undefined && typeof summary.cwd !== 'string') ||
        (summary.agentPreset !== undefined && typeof summary.agentPreset !== 'string')
      )
        throw malformedResponse('$events api-session/added')
      return [
        {
          type: 'host/session-added',
          sessionId: summary.sessionId,
          blank: summary.blank,
          ...(summary.agentAvailable === undefined ? {} : { agentAvailable: summary.agentAvailable }),
          ...(summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId }),
          ...(summary.origin === undefined ? {} : { origin: summary.origin }),
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(summary.agentPreset === undefined ? {} : { agentPreset: summary.agentPreset }),
        },
      ]
    }
    case 'api-session/removed':
      if (args.length !== 1 || !isNonEmptyString(args[0]))
        throw malformedResponse('$events api-session/removed')
      return [{ type: 'host/session-removed', sessionId: args[0] }]
    case 'api-session/status':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || typeof args[1] !== 'boolean')
        throw malformedResponse('$events api-session/status')
      return [{ type: 'host/session-status', sessionId: args[0], running: args[1] }]
    case 'api-session/activity':
      if (
        args.length !== 2 ||
        !isNonEmptyString(args[0]) ||
        !Number.isSafeInteger(args[1]) ||
        (args[1] as number) < 0
      )
        throw malformedResponse('$events api-session/activity')
      return [{ type: 'host/session-activity', sessionId: args[0], updatedAt: args[1] }]
    case 'api-session/error':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || typeof args[1] !== 'string')
        throw malformedResponse('$events api-session/error')
      return [{ type: 'host/agent-error', sessionId: args[0], message: args[1] }]
    case 'agent-preset/selected':
      if (args.length !== 2 || !isNonEmptyString(args[0]) || !isNonEmptyString(args[1]))
        throw malformedResponse('$events agent-preset/selected')
      return [
        {
          type: 'session/event',
          sessionId: args[0],
          event: { type: 'agent-preset/selected', data: { agentPreset: args[1] } },
        },
      ]
    default:
      return [{ type: 'host/remote-event', event, args }]
  }
}

type AlphaProviderInfo = Record<string, unknown> & { readonly id: string; readonly name: string }

type AlphaConfigurableProvider = Record<string, unknown> & {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
  readonly declared?: boolean
}

function validAlphaProviderInfo(value: unknown): value is AlphaProviderInfo {
  const row = recordOrUndefined(value)
  return row !== undefined && isNonEmptyString(row.id) && isNonEmptyString(row.name)
}

function validAlphaConfigurableProvider(value: unknown): value is AlphaConfigurableProvider {
  const row = recordOrUndefined(value)
  return (
    row !== undefined &&
    isNonEmptyString(row.provider) &&
    isNonEmptyString(row.displayName) &&
    isNonEmptyString(row.settingsNs) &&
    isNonEmptyStringArray(row.settingsPath) &&
    (row.declared === undefined || typeof row.declared === 'boolean')
  )
}

function alphaProviderInfoList(value: unknown): readonly AlphaProviderInfo[] {
  if (!Array.isArray(value) || !value.every(validAlphaProviderInfo))
    throw malformedResponse('llm/listProviders')
  return value
}

function alphaConfigurableProviderList(value: unknown): readonly AlphaConfigurableProvider[] {
  if (!Array.isArray(value) || !value.every(validAlphaConfigurableProvider))
    throw malformedResponse('llm/listConfigurableProviders')
  return value
}

function validAlphaResult(value: unknown): value is AlphaResult {
  const record = recordOrUndefined(value)
  if (record?.ok === true) return true
  const error = recordOrUndefined(record?.error)
  return (
    record?.ok === false &&
    error !== undefined &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    isPlainRecord(error.details)
  )
}

function normalizeAlphaResult(
  result: AlphaResult,
  normalizeErrorCode?: AlphaErrorCodeNormalizer,
): AlphaResult {
  if (result.ok || normalizeErrorCode === undefined) return result
  return {
    ...result,
    error: {
      ...result.error,
      code: normalizeErrorCode(result.error.code, result.error.details),
    },
  }
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
}

function withoutKeys(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const excluded = new Set(keys)
  return Object.fromEntries(Object.entries(value).filter(([name]) => !excluded.has(name)))
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new AppError({ code: 'INVALID_CONFIGURATION', message: `${label} is required.`, retryable: false })
  return value
}

function assertRemoteEndpoint(endpoint: string): void {
  const segments = endpoint.split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_$.-]+$/u.test(segment),
    )
  )
    throw new AppError({
      code: 'INVALID_CONFIGURATION',
      message: 'The alpha DSH Remote endpoint is invalid.',
      retryable: false,
    })
}

function rejectionError(reason: unknown): Error {
  // AbortSignal and WebSocket failure paths can carry arbitrary reasons. Keep
  // existing Error instances (including AppError classifications) intact, and
  // retain non-Error values as causes while satisfying Promise's Error contract.
  return reason instanceof Error ? reason : new Error('The alpha DSH stream failed.', { cause: reason })
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(rejectionError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(rejectionError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(rejectionError(error))
      },
    )
  })
}
