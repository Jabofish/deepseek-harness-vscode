import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

import { AppError, type BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport, RetryPolicy } from '../../contracts.js'
import { cancelled, httpFailure, normalizeTransportError } from '../../transport-errors.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

/** The small subset of the `ws`/browser WebSocket surface used by the adapter. */
export interface AlphaWebSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void, options?: AddEventListenerOptions): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

export interface AlphaWebSocketConstructor {
  new (url: string, options?: { readonly headers?: Readonly<Record<string, string>> }): AlphaWebSocket
}

/** Normalize one upstream alpha Remote code into the local compatibility vocabulary. */
export type AlphaErrorCodeNormalizer = (code: string, details: Readonly<Record<string, unknown>>) => string

export interface AlphaLoopbackApiClientOptions {
  readonly endpoint: BackendEndpoint
  readonly requestTimeoutMs: number
  readonly retryPolicy: RetryPolicy
  readonly fetch: typeof globalThis.fetch
  /** The Extension Host owns the browser-auth cookie; the Webview never sees it. */
  readonly authCookie?: (endpoint: BackendEndpoint) => string | undefined
  readonly webSocket?: AlphaWebSocketConstructor
  /** Optional version-specific Remote error compatibility profile. */
  readonly normalizeErrorCode?: AlphaErrorCodeNormalizer
}

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
  private readonly closed = new AbortController()
  private readonly remoteMux: AlphaRemoteMux
  private isClosed = false

  public constructor(private readonly options: AlphaLoopbackApiClientOptions) {
    assertLoopback(options.endpoint)
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
    const requestSignal = combineSignals(signal, this.closed.signal, this.options.requestTimeoutMs)
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
    const pending = this.pendingEvents.get(rpcId)
    const clientId = pending?.clientId
    if (clientId === undefined || clientId !== this.eventClientId)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The DSH interaction stream is no longer active.',
        retryable: true,
      })
    const outcome = alphaEventOutcome(result)
    const response = await this.post(
      '$events/result',
      { args: { clientId, eventId: rpcId, outcome } },
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

  public async close(): Promise<void> {
    if (this.isClosed) return Promise.resolve()
    this.isClosed = true
    this.closed.abort()
    await this.remoteMux.close()
  }

  private readonly pendingEvents = new Map<
    string,
    { readonly clientId: string; readonly kind: 'approval' | 'question'; readonly sessionId: string }
  >()
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
        return this.legacy(`workspace/${method.slice('workspace.'.length)}`, { request: value }, signal)
      case 'skill.list':
        return this.legacy('skills/list', { request: { sessionId: value.sessionId } }, signal)
      case 'agentPreset.list':
        return this.legacy('agentPresets/list', {}, signal, presetRoster)
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
          (result) => ({ agentPreset: result }),
        )
      case 'agentPreset.openDocument':
        return this.legacy('settings/openAgentPresetDirectory', { agentPreset: value.agentPreset }, signal)
      case 'agentPreset.remove':
        return this.legacy('agentPresets/deletePreset', { id: value.agentPreset }, signal, () => ({}))
      case 'goal.create':
        return this.legacy(
          'goals/create',
          { agentId: value.sessionId, request: { objective: value.objective } },
          signal,
        )
      case 'goal.edit':
        return this.legacy(
          'goals/edit',
          { agentId: value.sessionId, ref: value.ref, request: { objective: value.objective } },
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
        return this.legacy('goals/clear', { agentId: value.sessionId, ref: value.ref }, signal, () => ({
          cleared: true,
        }))
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
        return this.legacy(method.replace('.', '/'), value, signal)
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

  /**
   * Alpha publishes the prompt's request id in the queue projection. The
   * legacy repository uses the transport response id for that correlation,
   * so expose the same logical id while keeping the physical Connection
   * envelope id private to `post`.
   */
  private async prompt(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const requestId = isNonEmptyString(value.requestId) ? value.requestId : randomUUID()
    const response = await this.legacy('session/prompt', { request: { ...value, requestId } }, signal)
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
    return { rpcId, result: result.ok && !Object.hasOwn(result, 'value') ? { ok: true, value: {} } : result }
  }

  private async history(value: Record<string, unknown>, signal?: AbortSignal): Promise<LegacyResponse> {
    const sessionId = stringValue(value.sessionId, 'session.history sessionId')
    const address = { kind: 'session', sessionId }
    const snapshot = await this.followSnapshot(
      { address, ...(value.maxMessages === undefined ? {} : { maxMessages: value.maxMessages }) },
      signal,
    )
    if (value.beforeSeq !== undefined) {
      const page = await this.unary(
        'session/page',
        {
          request: {
            address,
            throughSeq: snapshot.cursor,
            beforeSeq: value.beforeSeq,
            maxMessages: value.maxMessages,
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
    const snapshot = await this.followSnapshot(
      { address, ...(value.maxMessages === undefined ? {} : { maxMessages: value.maxMessages }) },
      signal,
    )
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
                maxMessages: value.maxMessages,
              },
            },
            signal,
          )
    return this.historyResponse(page, sessionId)
  }

  private async followSnapshot(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    for await (const item of this.openRemoteStream('session/follow', { request }, signal)) {
      const frame = recordOrUndefined(item)
      if (!validAlphaSessionSnapshot(frame)) throw malformedResponse('session/follow snapshot')
      return frame
    }
    throw malformedResponse('session/follow snapshot')
  }

  private historyResponse(value: unknown, sessionId: string): LegacyResponse {
    const record = recordOrUndefined(value)
    if (
      record === undefined ||
      !Array.isArray(record.records) ||
      typeof record.hasMore !== 'boolean' ||
      (record.projections !== undefined && !validAlphaProjectionBaseline(record.projections))
    )
      throw malformedResponse('session history')
    const events = expandHistoryRecords(record.records, sessionId)
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
    const response = await this.post('session/modelCatalog', { args: {} }, signal)
    if (!response.result.ok) return response
    const catalog = recordOrUndefined(response.result.value)
    if (catalog === undefined) throw malformedResponse('session/modelCatalog')
    const selected = recordOrUndefined(catalog.default)
    if (selected === undefined) throw malformedResponse('session/modelCatalog default')
    return {
      ...response,
      result: {
        ok: true,
        value: {
          current: selected,
          routable:
            Array.isArray(catalog.routableProviders) && catalog.routableProviders.includes(selected.provider),
          groups: catalog.groups,
          failures: catalog.failures,
        },
      },
    }
  }

  private async providers(signal?: AbortSignal): Promise<LegacyResponse> {
    const [providers, configurable] = await Promise.all([
      this.post('llm/listProviders', { args: {} }, signal),
      this.post('llm/listConfigurableProviders', { args: {} }, signal),
    ])
    if (!providers.result.ok) return providers
    if (!configurable.result.ok) return configurable
    const listed = Array.isArray(providers.result.value) ? providers.result.value : []
    const configs = Array.isArray(configurable.result.value) ? configurable.result.value : []
    const byProvider = new Map<string, Record<string, unknown>>()
    for (const entry of configs) {
      const row = asRecord(entry)
      if (typeof row?.provider === 'string') byProvider.set(row.provider, row)
    }
    const mapped = listed.flatMap((entry) => {
      const row = asRecord(entry)
      if (typeof row?.id !== 'string' || typeof row.name !== 'string') return []
      const config = byProvider.get(row.id)
      return [
        {
          provider: row.id,
          displayName: row.name,
          settingsNs: typeof config?.settingsNs === 'string' ? config.settingsNs : row.id,
          settingsPath: Array.isArray(config?.settingsPath) ? config.settingsPath : [],
          active: true,
          ...(config?.declared === undefined ? {} : { declared: config.declared }),
        },
      ]
    })
    return {
      rpcId: providers.rpcId,
      result: { ok: true, value: { providers: mapped } },
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
      !isNonEmptyStringArray(baseline.archivedSessionIds)
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
          continue
        }
        if (frame?.type === 'ready') throw malformedResponse('$events ready')
        if (frame?.type === 'emit' && validAlphaEventEmit(frame)) {
          yield* mapEmit(frame.event, frame.args)
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
    } finally {
      if (this.eventStreamGeneration === generation) {
        this.eventClientId = undefined
        this.pendingEvents.clear()
      }
    }
  }

  private async *readControl(signal: AbortSignal): AsyncGenerator<unknown> {
    for await (const item of this.openRemoteStream('session/control', {}, signal)) {
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
        yield frame
      } else {
        throw malformedResponse('session/control frame')
      }
    }
  }

  private async *readSession(sessionId: string, signal: AbortSignal): AsyncGenerator<unknown> {
    const request = { address: { kind: 'session', sessionId }, maxMessages: 50 }
    for await (const item of this.openRemoteStream('session/follow', { request }, signal)) {
      const frame = recordOrUndefined(item)
      if (frame?.type === 'snapshot') {
        if (!validAlphaSessionSnapshot(frame)) throw malformedResponse('session/follow snapshot')
        for (const event of expandHistoryRecords(frame.records, sessionId))
          yield { type: 'session/event', sessionId, event }
        yield {
          type: 'session/subscribed',
          sessionId,
          lastSeq: frame.cursor,
          projections: frame.projections,
        }
      } else if (frame?.type === 'event') {
        if (!validAlphaSessionEventFrame(frame)) throw malformedResponse('session/follow event')
        const event = normalizeAlphaEvent(frame.event, sessionId)
        yield { type: 'session/event', sessionId, event }
      } else throw malformedResponse('session/follow frame')
    }
  }

  private async *readWorkspace(signal: AbortSignal): AsyncGenerator<unknown> {
    for await (const item of this.openRemoteStream('workspace/follow', {}, signal)) {
      const frame = recordOrUndefined(item)
      if (frame?.type === 'baseline') {
        const value = recordOrUndefined(frame.value)
        if (
          value === undefined ||
          !Array.isArray(value.items) ||
          !value.items.every(isPlainRecord) ||
          !isNonEmptyStringArray(value.archivedSessionIds)
        )
          throw malformedResponse('workspace/follow baseline')
        yield { type: 'host/workspace-changed' }
        yield { type: 'host/archived-sessions-changed', sessionIds: value.archivedSessionIds }
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
      } else throw malformedResponse('workspace/follow frame')
    }
  }

  private async *openRemoteStream(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    if (this.isClosed) return
    const requestSignal = combineSignals(signal, this.closed.signal)
    for await (const item of this.remoteMux.open(endpoint, args, requestSignal)) yield item
  }

  private async withRetry<T>(method: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let last: AppError | undefined
    for (let attempt = 0; attempt < Math.max(1, this.options.retryPolicy.maximumAttempts); attempt += 1) {
      if (signal?.aborted === true) throw cancelled(signal.reason)
      try {
        return await operation()
      } catch (error) {
        const normalized = normalizeTransportError(method, error, signal)
        last = normalized
        if (
          !normalized.retryable ||
          !isAlphaIdempotentMethod(method) ||
          attempt + 1 >= this.options.retryPolicy.maximumAttempts
        )
          throw normalized
        await delay(
          Math.min(
            this.options.retryPolicy.maximumDelayMs,
            this.options.retryPolicy.baseDelayMs * 2 ** attempt,
          ),
          signal,
        )
      }
    }
    throw (
      last ??
      new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: `The DSH request ${method} failed.`,
        retryable: true,
      })
    )
  }
}

interface AlphaMuxStream {
  readonly endpoint: string
  readonly queue: AsyncQueue<unknown>
  socket?: AlphaWebSocket
  terminal: boolean
}

/**
 * Keep one physical alpha Gateway connection per backend and multiplex the
 * independently cancellable logical streams required by `remote.mux`.
 */
class AlphaRemoteMux {
  private socket: AlphaWebSocket | undefined
  private connectingSocket: AlphaWebSocket | undefined
  private socketCleanup: (() => void) | undefined
  private connecting: Promise<AlphaWebSocket> | undefined
  private readonly streams = new Map<string, AlphaMuxStream>()
  private closed = false

  public constructor(private readonly options: AlphaLoopbackApiClientOptions) {}

  public async *open(
    endpoint: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    if (this.closed) throw closedError()
    if (signal?.aborted === true) return

    const state: AlphaMuxStream = {
      endpoint,
      queue: new AsyncQueue<unknown>(RECEIVE_QUEUE_LIMIT),
      terminal: false,
    }
    const streamId = randomUUID()
    this.streams.set(streamId, state)
    const handleAbort = (): void => {
      if (state.terminal) return
      state.terminal = true
      this.sendCancel(streamId, state)
      state.queue.end()
    }
    signal?.addEventListener('abort', handleAbort, { once: true })

    try {
      let socket: AlphaWebSocket
      try {
        socket = await this.ensureSocket(signal)
      } catch (error) {
        if (error instanceof AppError && error.code === 'REQUEST_CANCELLED') return
        throw error
      }
      if (state.terminal || this.closed) return
      state.socket = socket
      this.send(socket, {
        type: 'open',
        streamId,
        endpoint,
        payload: { args },
      })
      for await (const item of state.queue) yield item
    } finally {
      signal?.removeEventListener('abort', handleAbort)
      if (!state.terminal) {
        state.terminal = true
        this.sendCancel(streamId, state)
        state.queue.end()
      }
      this.streams.delete(streamId)
    }
  }

  public close(): Promise<void> {
    this.closed = true
    for (const state of this.streams.values()) {
      state.terminal = true
      state.queue.end()
    }
    this.streams.clear()

    const socket = this.socket ?? this.connectingSocket
    this.socket = undefined
    this.connectingSocket = undefined
    this.socketCleanup?.()
    this.socketCleanup = undefined
    if (socket !== undefined && (socket.readyState === 0 || socket.readyState === 1)) {
      try {
        socket.close()
      } catch {
        /* disposal is best effort */
      }
    }
    return Promise.resolve()
  }

  private async ensureSocket(signal?: AbortSignal): Promise<AlphaWebSocket> {
    if (this.closed) throw closedError()
    if (this.socket?.readyState === 1) return this.socket
    const pending =
      this.connecting ??
      (() => {
        const connection = this.connect()
        this.connecting = connection
        void connection.then(
          () => {
            if (this.connecting === connection) this.connecting = undefined
          },
          () => {
            if (this.connecting === connection) this.connecting = undefined
          },
        )
        return connection
      })()
    return this.waitFor(pending, signal)
  }

  private async connect(): Promise<AlphaWebSocket> {
    const WebSocketConstructor = this.options.webSocket ?? WebSocket
    if (typeof WebSocketConstructor !== 'function')
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The Extension Host does not provide WebSocket transport.',
        retryable: true,
      })

    const target = new URL('/api/remote.mux', this.options.endpoint.baseUrl)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    const cookie = this.options.authCookie?.(this.options.endpoint)
    const socket =
      cookie === undefined || cookie.trim() === ''
        ? new WebSocketConstructor(target.toString())
        : new WebSocketConstructor(target.toString(), { headers: { Cookie: cookie } })
    this.connectingSocket = socket

    return new Promise<AlphaWebSocket>((resolve, reject) => {
      let settled = false
      let opened = false
      const timerState: { timer?: ReturnType<typeof setTimeout> } = {}
      let removed = false
      const removeListeners = (): void => {
        if (removed) return
        removed = true
        if (timerState.timer !== undefined) clearTimeout(timerState.timer)
        socket.removeEventListener('open', handleOpen)
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('error', handleError)
        socket.removeEventListener('close', handleClose)
        if (this.socketCleanup === removeListeners) this.socketCleanup = undefined
      }
      const failBeforeOpen = (error: unknown): void => {
        if (settled) return
        settled = true
        if (this.connectingSocket === socket) this.connectingSocket = undefined
        removeListeners()
        try {
          if (socket.readyState === 0 || socket.readyState === 1) socket.close()
        } catch {
          /* close is best effort after a failed handshake */
        }
        reject(
          error instanceof Error ? error : new Error('The alpha DSH handshake failed.', { cause: error }),
        )
      }
      const handleOpen = (): void => {
        if (settled) return
        if (this.closed) {
          failBeforeOpen(closedError())
          return
        }
        settled = true
        opened = true
        if (this.connectingSocket === socket) this.connectingSocket = undefined
        if (timerState.timer !== undefined) clearTimeout(timerState.timer)
        this.socket = socket
        this.socketCleanup = removeListeners
        resolve(socket)
      }
      const handleMessage = (event: unknown): void => {
        if (!opened) {
          failBeforeOpen(malformedResponse('remote.mux'))
          return
        }
        this.dispatch(socket, event, removeListeners)
      }
      const handleError = (event: unknown): void => {
        const error = normalizeTransportError('remote.mux', socketError(event))
        if (!opened) failBeforeOpen(error)
        else this.failSocket(socket, error, removeListeners)
      }
      const handleClose = (): void => {
        const error = new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: opened
            ? 'The alpha DSH multiplexed stream closed unexpectedly.'
            : 'The alpha DSH multiplexed stream closed before it became ready.',
          retryable: true,
        })
        if (!opened) failBeforeOpen(error)
        else this.failSocket(socket, error, removeListeners)
      }

      socket.addEventListener('open', handleOpen)
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('error', handleError)
      socket.addEventListener('close', handleClose)
      timerState.timer = setTimeout(
        () =>
          failBeforeOpen(
            new AppError({
              code: 'BACKEND_UNREACHABLE',
              message: 'The alpha DSH multiplexed stream timed out before it became ready.',
              retryable: true,
              context: { method: 'remote.mux', timedOut: true },
            }),
          ),
        this.options.requestTimeoutMs,
      )
      if (socket.readyState === 1) queueMicrotask(handleOpen)
      else if (socket.readyState === 3) queueMicrotask(handleClose)
    })
  }

  private dispatch(socket: AlphaWebSocket, event: unknown, cleanup: () => void): void {
    let frame: Record<string, unknown>
    try {
      const text = textOfSocketData(event)
      if (text.length > 8 * 1024 * 1024) throw new Error('frame too large')
      const decoded: unknown = JSON.parse(text)
      if (!isPlainRecord(decoded)) throw new Error('frame is not an object')
      frame = decoded
    } catch (cause) {
      this.failSocket(socket, malformedResponse('remote.mux', cause), cleanup)
      return
    }

    const streamId = frame.streamId
    if (typeof streamId !== 'string' || streamId.trim() === '') {
      this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
      return
    }
    const state = this.streams.get(streamId)
    switch (frame.type) {
      case 'item':
        if (
          !hasExactKeys(frame, ['type', 'streamId']) &&
          !hasExactKeys(frame, ['type', 'streamId', 'value'])
        ) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) state.queue.push(frame.value)
        return
      case 'end':
        if (!hasExactKeys(frame, ['type', 'streamId'])) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) {
          state.terminal = true
          state.queue.end()
        }
        return
      case 'error':
        if (!hasExactKeys(frame, ['type', 'streamId', 'error']) || !validAlphaStreamError(frame.error)) {
          this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
          return
        }
        if (state !== undefined && !state.terminal) {
          state.terminal = true
          state.queue.fail(alphaStreamError(frame.error, this.options.normalizeErrorCode))
        }
        return
      default:
        this.failSocket(socket, malformedResponse('remote.mux'), cleanup)
    }
  }

  private failAll(error: unknown): void {
    for (const state of this.streams.values()) {
      state.terminal = true
      state.queue.fail(error)
    }
  }

  private failSocket(socket: AlphaWebSocket, error: unknown, cleanup: () => void): void {
    cleanup()
    if (this.socket === socket) this.socket = undefined
    if (!this.closed) this.failAll(error)
    try {
      if (socket.readyState === 0 || socket.readyState === 1) socket.close()
    } catch {
      /* close is best effort after a transport failure */
    }
  }

  private send(socket: AlphaWebSocket, message: Record<string, unknown>): void {
    if (socket.readyState !== 1)
      throw normalizeTransportError('remote.mux', new Error('The alpha DSH stream is not open.'))
    try {
      socket.send(JSON.stringify(message))
    } catch (cause) {
      throw normalizeTransportError('remote.mux', cause)
    }
  }

  private sendCancel(streamId: string, state: AlphaMuxStream): void {
    const socket = state.socket
    if (socket === undefined || socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify({ type: 'cancel', streamId }))
    } catch {
      /* cancellation is best effort; the physical socket remains shared */
    }
  }

  private async waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return promise
    if (signal.aborted) throw cancelled(signal.reason)
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const handleAbort = (): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', handleAbort)
        reject(cancelled(signal.reason))
      }
      signal.addEventListener('abort', handleAbort, { once: true })
      void promise.then(
        (value) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', handleAbort)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', handleAbort)
          reject(error instanceof Error ? error : new Error('The alpha DSH stream failed.', { cause: error }))
        },
      )
    })
  }
}

const ALPHA_IDEMPOTENT_METHODS = new Set([
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'subagent.list',
  'subagent.history',
  'host.listDirectory',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'agentPreset.read',
  'settings.describe',
  'credentials.describe',
  'llm.providers',
  'llm.models',
  'commands/list',
  'fileReferences/list',
  'sessionReferenceResolver/candidates',
  'messageFeedback/list',
  'pluginInventory/list',
  'agentPresets/list',
  'agentPresets/read',
  'settings/describe',
  'credentials/describe',
  'llm/listProviders',
  'llm/listConfigurableProviders',
  'session/list',
  'session/search',
  'session.attachment',
  'session/modelCatalog',
  'session/page',
  'session/follow',
  'workspace/follow',
  'directoryPicker/list',
  'subagents/list',
  'subagents/catalog',
])

function isAlphaIdempotentMethod(method: string): boolean {
  return ALPHA_IDEMPOTENT_METHODS.has(method)
}

function mapEmit(event: unknown, args: readonly unknown[]): readonly unknown[] {
  switch (event) {
    case 'api-session/added': {
      const summary = recordOrUndefined(args[0])
      if (args.length !== 1 || summary === undefined || !isNonEmptyString(summary.sessionId))
        throw malformedResponse('$events api-session/added')
      return [{ ...summary, type: 'host/session-added' }]
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

function alphaSessionList(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined || !Array.isArray(record.items))
    throw new Error('session list is not an object with items')
  return {
    ...record,
    items: record.items.map((entry) => {
      const item = recordOrUndefined(entry)
      if (item === undefined || typeof item.sessionId !== 'string' || item.sessionId.trim() === '')
        throw new Error('session list item is malformed')
      if (hasDefinedAlphaTitle(item)) return item
      return {
        ...item,
        title: workspaceTitleFromPath(item.cwd) ?? item.sessionId,
      }
    }),
  }
}

function hasDefinedAlphaTitle(value: Record<string, unknown>): boolean {
  if (typeof value.title === 'string' || typeof value.name === 'string') return true
  const projections = recordOrUndefined(value.projections)
  const values = recordOrUndefined(projections?.values)
  return typeof values?.title === 'string'
}

function normalizeAlphaEvent(value: unknown, sessionId: string): Record<string, unknown> | undefined {
  const event = recordOrUndefined(value)
  if (event === undefined || typeof event.type !== 'string') return undefined
  if (event.type === 'goal/change') {
    const data = asRecord(event.data) ?? {}
    return {
      ...event,
      type: 'goal/updated',
      data: { goals: data.cleared === true ? [] : data.goal === undefined ? [] : [data.goal] },
    }
  }
  return { ...event, sessionId }
}

function expandHistoryRecords(
  records: readonly unknown[],
  sessionId: string,
): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of records) {
    const record = recordOrUndefined(raw)
    if (record?.type === 'event') {
      const event = recordOrUndefined(record.event)
      if (event === undefined || !validAlphaSessionEvent(event))
        throw malformedResponse('session history event')
      out.push({ ...event, sessionId })
    } else if (record?.type === 'chunks') out.push(...expandChunkRow(record.event, sessionId))
    else throw malformedResponse('session history record')
  }
  return out
}

function expandChunkRow(value: unknown, sessionId: string): readonly Record<string, unknown>[] {
  const row = recordOrUndefined(value)
  const data = recordOrUndefined(row?.data)
  const rowType =
    row?.type === 'chunkrow/text-chunks' ||
    row?.type === 'chunkrow/reasoning-chunks' ||
    row?.type === 'chunkrow/tool-call-chunks'
      ? row.type.slice('chunkrow/'.length)
      : undefined
  if (
    row === undefined ||
    data === undefined ||
    rowType === undefined ||
    !hasExactKeys(row, ['type', 'seq', 'time', 'data']) ||
    !Number.isSafeInteger(row.seq) ||
    (row.seq as number) < 0 ||
    !Number.isSafeInteger(row.time) ||
    typeof data.turn !== 'number' ||
    typeof data.step !== 'number' ||
    typeof data.index !== 'number'
  )
    throw malformedResponse('chunk row')
  const dataKeys =
    rowType === 'tool-call-chunks'
      ? Object.hasOwn(data, 'name')
        ? ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']
        : ['turn', 'step', 'index', 'id', 'dt', 'args']
      : ['turn', 'step', 'index', 'dt', 'texts']
  if (!hasExactKeys(data, dataKeys)) throw malformedResponse('chunk row data')
  const turn = data.turn
  const step = data.step
  const blockIndex = data.index
  if (typeof turn !== 'number' || typeof step !== 'number' || typeof blockIndex !== 'number')
    throw malformedResponse('chunk row data')
  const payloadKey = rowType === 'tool-call-chunks' ? 'args' : 'texts'
  const payload = data[payloadKey]
  const gaps = data.dt
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    !payload.every((entry) => typeof entry === 'string') ||
    !Array.isArray(gaps) ||
    gaps.length !== payload.length - 1 ||
    !gaps.every(Number.isSafeInteger)
  )
    throw malformedResponse('chunk row data')
  if (
    rowType === 'tool-call-chunks' &&
    (typeof data.id !== 'string' || (Object.hasOwn(data, 'name') && typeof data.name !== 'string'))
  )
    throw malformedResponse('tool chunk row')
  if (payload.length - 1 > Number.MAX_SAFE_INTEGER - (row.seq as number))
    throw malformedResponse('chunk row sequence')
  const out: Record<string, unknown>[] = []
  let time = row.time as number
  for (let memberIndex = 0; memberIndex < payload.length; memberIndex += 1) {
    if (memberIndex > 0) time += gaps[memberIndex - 1] as number
    if (!Number.isSafeInteger(time)) throw malformedResponse('chunk row time')
    const chunk =
      rowType === 'text-chunks'
        ? { type: 'text-delta', index: blockIndex, text: payload[memberIndex] }
        : rowType === 'reasoning-chunks'
          ? { type: 'reasoning-delta', index: blockIndex, text: payload[memberIndex] }
          : {
              type: 'tool-call-delta',
              index: blockIndex,
              id: data.id,
              ...(data.name === undefined ? {} : { name: data.name }),
              argumentsDelta: payload[memberIndex],
            }
    out.push({
      type: 'assistant/chunk',
      seq: (row.seq as number) + memberIndex,
      time,
      data: { turn, step, chunk },
      sessionId,
    })
  }
  return out
}

function alphaEventOutcome(result: unknown): Record<string, unknown> {
  const value = asRecord(result)
  if (value?.ok === true)
    return { kind: 'result', ...(value.value === undefined ? {} : { value: value.value }) }
  if (value?.ok === false) {
    const error = asRecord(value.error) ?? {}
    return {
      kind: 'rejected',
      error: {
        name: 'DshInteractionError',
        message: typeof error.message === 'string' ? error.message : 'The DSH interaction was rejected.',
        ...(typeof error.code === 'string' ? { code: error.code } : {}),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
  return {
    kind: 'rejected',
    error: {
      name: 'DshInteractionError',
      message: 'The DSH interaction response was malformed.',
      code: 'bad-request',
      details: {},
    },
  }
}

function presetRoster(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('preset roster is not an object')
  return { ...record, hasDocument: record.authorable === true }
}

function presetDocument(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('preset document is not an object')
  return { ...record, agentPreset: record.agentPreset ?? record.id }
}

function goalReceipt(value: unknown): unknown {
  const record = recordOrUndefined(value)
  const refValue = record !== undefined && Object.hasOwn(record, 'ref') ? record.ref : value
  const ref = recordOrUndefined(refValue)
  if (ref === undefined) throw new Error('goal receipt is not an object')
  return { ref: { id: ref.id, revision: ref.revision } }
}

function modelCatalog(value: unknown): unknown {
  const record = recordOrUndefined(value)
  if (record === undefined) throw new Error('model catalog is not an object')
  const selected = recordOrUndefined(record.default)
  if (selected === undefined) throw new Error('model catalog default is not an object')
  return {
    ...record,
    current: selected,
    routable: Array.isArray(record.routableProviders) && record.routableProviders.includes(selected.provider),
  }
}

interface AlphaSessionSnapshot extends Record<string, unknown> {
  readonly type: 'snapshot'
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections: Record<string, unknown>
}

interface AlphaSessionEventFrame extends Record<string, unknown> {
  readonly type: 'event'
  readonly event: Record<string, unknown>
}

interface AlphaEventReady extends Record<string, unknown> {
  readonly type: 'ready'
  readonly clientId: string
}

interface AlphaEventEmit extends Record<string, unknown> {
  readonly type: 'emit'
  readonly event: string
  readonly args: readonly unknown[]
}

interface AlphaEventWaterfall extends Record<string, unknown> {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: string
  readonly agentId: string
  readonly request: Record<string, unknown>
}

interface AlphaEventCancel extends Record<string, unknown> {
  readonly type: 'cancel'
  readonly eventId: string
}

function validAlphaSessionSnapshot(value: unknown): value is AlphaSessionSnapshot {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    record.type === 'snapshot' &&
    isPlainRecord(record.header) &&
    isSafeAlphaCursor(record.cursor) &&
    Array.isArray(record.records) &&
    typeof record.hasMore === 'boolean' &&
    validAlphaProjectionBaseline(record.projections)
  )
}

function validAlphaSessionEventFrame(value: unknown): value is AlphaSessionEventFrame {
  const record = recordOrUndefined(value)
  const event = record?.event
  return record?.type === 'event' && isPlainRecord(event) && validAlphaSessionEvent(event)
}

function validAlphaSessionEvent(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === 'string' &&
    value.type.length > 0 &&
    isSafeAlphaSequence(value.seq) &&
    typeof value.time === 'number' &&
    Number.isSafeInteger(value.time) &&
    value.time >= 0 &&
    (value.ignorable === undefined || value.ignorable === true) &&
    isJsonLike(value.data)
  )
}

function validAlphaProjectionBaseline(value: unknown): value is Record<string, unknown> {
  const projection = isPlainRecord(value) ? value : undefined
  return projection !== undefined && isSafeAlphaCursor(projection.asOfSeq) && isPlainRecord(projection.values)
}

function validAlphaEventReady(value: unknown): value is AlphaEventReady {
  const record = recordOrUndefined(value)
  const host = record?.host
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'clientId', 'host']) &&
    record.type === 'ready' &&
    isNonEmptyString(record.clientId) &&
    isPlainRecord(host) &&
    hasExactKeys(host, ['home']) &&
    typeof host.home === 'string'
  )
}

function validAlphaEventEmit(value: unknown): value is AlphaEventEmit {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event', 'args']) &&
    record.type === 'emit' &&
    isNonEmptyString(record.event) &&
    Array.isArray(record.args) &&
    isJsonLike(record.args)
  )
}

function validAlphaEventWaterfall(value: unknown): value is AlphaEventWaterfall {
  const record = recordOrUndefined(value)
  const request = record?.request
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'event', 'eventId', 'agentId', 'request']) &&
    record.type === 'waterfall' &&
    isNonEmptyString(record.event) &&
    isNonEmptyString(record.eventId) &&
    isNonEmptyString(record.agentId) &&
    isPlainRecord(request) &&
    !Object.hasOwn(request, 'agent') &&
    !Object.hasOwn(request, 'signal') &&
    isJsonLike(request)
  )
}

function validAlphaEventCancel(value: unknown): value is AlphaEventCancel {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    hasExactKeys(record, ['type', 'eventId']) &&
    record.type === 'cancel' &&
    isNonEmptyString(record.eventId)
  )
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isSafeAlphaCursor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= -1
}

function isSafeAlphaSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function workspaceTitleFromPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const segments = value
    .trim()
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]/u)
    .filter(Boolean)
  return segments.at(-1)
}

function isJsonLike(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      )
        return false
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonLike(value[index], seen)) return false
      }
      return true
    }
    const prototype = Reflect.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor?.enumerable !== true || !isJsonLike(Reflect.get(value, key), seen)) return false
    }
    return true
  } finally {
    seen.delete(value)
  }
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

function validAlphaStreamError(value: unknown): value is Record<string, unknown> {
  const error = recordOrUndefined(value)
  return (
    error !== undefined &&
    hasExactKeys(error, ['code', 'message', 'details']) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    isPlainRecord(error.details)
  )
}

function alphaStreamError(value: unknown, normalizeErrorCode?: AlphaErrorCodeNormalizer): AppError {
  const error = recordOrUndefined(value) ?? {}
  if (typeof error.code === 'string' && typeof error.message === 'string' && isPlainRecord(error.details)) {
    const code = normalizeErrorCode?.(error.code, error.details) ?? error.code
    try {
      unwrapRpcResultValue(
        { ok: false, error: { code, message: error.message, details: error.details } },
        'alpha stream',
      )
    } catch (cause) {
      if (cause instanceof AppError) return cause
    }
  }
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The alpha DSH stream failed.',
    retryable: true,
    context: {
      rpcCode:
        typeof error.code === 'string'
          ? (normalizeErrorCode?.(error.code, isPlainRecord(error.details) ? error.details : {}) ??
            error.code)
          : 'internal',
    },
  })
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

function textOfSocketData(event: unknown): string {
  const data = asRecord(event)?.data ?? event
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return new TextDecoder().decode(data)
  throw new Error('alpha DSH stream message is not text')
}

function socketError(event: unknown): Error {
  const error = asRecord(event)?.error
  return error instanceof Error ? error : new Error('The alpha DSH WebSocket failed.')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined
}

function credentialDescribe(value: unknown): unknown {
  const credentials = recordOrUndefined(value)
  if (credentials === undefined) throw new Error('credential describe is not an object')
  return { credentials }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Reflect.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

function assertLoopback(endpoint: BackendEndpoint): void {
  if (
    (endpoint.host !== '127.0.0.1' && endpoint.host !== 'localhost') ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535 ||
    endpoint.baseUrl !== `http://${endpoint.host}:${endpoint.port}`
  )
    throw new AppError({
      code: 'INVALID_ENDPOINT',
      message: 'DSH connections must use a validated loopback endpoint.',
      retryable: false,
    })
}

function closedError(): AppError {
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The DSH connection is closed.',
    retryable: false,
  })
}

/**
 * Callers never read a non-2xx body, and an unconsumed fetch body pins its
 * socket instead of returning it to the pool. Release it explicitly so
 * retry loops and export failures cannot accumulate stalled connections.
 */
async function releaseUnreadBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* releasing the connection is best effort */
  }
}

function malformedResponse(method: string, cause?: unknown): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed alpha response for ${method}.`,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  })
}

function combineSignals(...signals: (AbortSignal | undefined | number)[]): AbortSignal {
  const sources = signals.filter(
    (value): value is AbortSignal => typeof value !== 'number' && value !== undefined,
  )
  const timeout = signals.find((value): value is number => typeof value === 'number')
  if (timeout !== undefined) sources.push(AbortSignal.timeout(timeout))
  return sources.length === 1 ? (sources[0] as AbortSignal) : AbortSignal.any(sources)
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw cancelled(signal.reason)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(cancelled(signal?.reason))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Matches the rc.6 transport's per-stream receive queue bound. */
const RECEIVE_QUEUE_LIMIT = 256

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private finished = false
  private failure: unknown

  public constructor(private readonly capacity: number) {}

  public push(value: T): void {
    if (this.finished) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) {
      // The stream consumer awaits inside its read loop (history recovery on
      // a seq gap), so the host can keep pushing frames while the generator
      // is suspended at its yield. Fail the stream past the same bound the
      // rc.6 transport enforces instead of buffering without limit; the
      // stream controller reconnects and re-snapshots.
      if (this.values.length >= this.capacity) {
        this.values.length = 0
        this.fail(
          new AppError({
            code: 'PROTOCOL_ERROR',
            message: 'The DSH event stream exceeded its receive queue limit.',
            retryable: true,
          }),
        )
        return
      }
      this.values.push(value)
      return
    }
    waiter.resolve({ value, done: false })
  }

  public end(): void {
    if (this.finished) return
    this.finished = true
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined as T, done: true })
  }

  public fail(error: unknown): void {
    if (this.finished) return
    this.failure = error
    this.finished = true
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift() as T, done: false })
        if (this.finished) {
          if (this.failure === undefined) return Promise.resolve({ value: undefined as T, done: true })
          return Promise.reject(
            this.failure instanceof Error ? this.failure : new Error('The alpha DSH stream failed.'),
          )
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }))
      },
    }
  }
}
