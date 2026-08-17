import {
  AppError,
  type AgentConfiguration,
  type BackendEvent,
  type PromptAttachment,
  type PromptInput,
  type QueuedInput,
  type RunningInputMode,
  type SessionCreateInput,
  type SessionDetail,
  type SessionHistoryEvent,
  type SessionListQuery,
  type SessionPage,
  type SessionRepository,
  type SessionSummary,
} from '@dsh-vscode/domain'
import { realpathSync } from 'node:fs'
import path from 'node:path'

import type { DshTransport } from '../contracts.js'
import { executeRc6Command } from './command-repository.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { permissionPresetIds, rc6Mapper } from '../versions/rc6/mapper.js'
import type { Rc6WorkspaceRepository } from './workspace-repository.js'

export class Rc6SessionRepository implements SessionRepository {
  private readonly queueOwners = new Map<string, string>()
  private readonly queues = new Map<string, readonly QueuedInput[]>()
  private readonly queueWaiters = new Map<string, Set<(items: readonly QueuedInput[]) => void>>()
  public constructor(
    private readonly transport: DshTransport,
    private readonly workspaceRepository?: Rc6WorkspaceRepository,
  ) {}

  public remember(event: BackendEvent): void {
    if (event.type !== 'queue.updated') {
      if (event.type === 'session.subscribed') {
        this.clearQueueState(event.sessionId)
        this.queues.set(event.sessionId, [])
      } else if (event.type === 'session.removed') {
        this.clearQueueState(event.sessionId)
      }
      return
    }
    this.queues.set(event.sessionId, event.items)
    const previous = new Set(
      [...this.queueOwners.entries()]
        .filter(([, sessionId]) => sessionId === event.sessionId)
        .map(([inputId]) => inputId),
    )
    for (const itemId of previous) this.queueOwners.delete(itemId)
    for (const item of event.items) this.queueOwners.set(item.id, event.sessionId)
    for (const waiter of this.queueWaiters.get(event.sessionId) ?? []) waiter(event.items)
  }

  public async list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage> {
    if (query?.cursor !== undefined && query.cursor.trim() !== '')
      throw unavailable('session list pagination')
    const value = await callRpc<unknown>(
      this.transport,
      'session.list',
      { ...(query?.cursor === undefined ? {} : { cursor: query.cursor }) },
      signal,
    )
    const list = requiredRecord(value, 'session list')
    if (
      !Array.isArray(list.items) ||
      !list.items.every(validSessionSummaryResponse) ||
      (list.nextCursor !== undefined && typeof list.nextCursor !== 'string')
    )
      throw malformedSessionResponse('session list')
    let items = list.items.map((item) => rc6Mapper.sessionSummary(item))
    let archivedSessionIds: ReadonlySet<string> | undefined
    if (this.workspaceRepository !== undefined) {
      const workspaceSnapshot = await this.workspaceRepository.listWithArchiveState(signal)
      const workspaces = workspaceSnapshot.items
      archivedSessionIds = workspaceSnapshot.archivedSessionIds
      const workspaceBySession = new Map<string, string>()
      for (const workspace of workspaces)
        for (const sessionId of workspace.sessionIds ?? []) workspaceBySession.set(sessionId, workspace.id)
      items = items.map((item) => {
        const workspaceId =
          workspaceBySession.get(item.id) ??
          (item.workspaceId.trim() === '' ? undefined : item.workspaceId) ??
          workspaces.find((workspace) => item.cwd !== undefined && samePath(workspace.path, item.cwd))?.id
        return { ...item, ...(workspaceId === undefined ? {} : { workspaceId }) }
      })
    }
    if (query?.workspaceId !== undefined)
      items = items.filter((item) => item.workspaceId === query.workspaceId)
    if (query?.archived !== undefined && archivedSessionIds !== undefined)
      items = items.filter((item) => archivedSessionIds.has(item.id) === query.archived)
    if (query?.search !== undefined && query.search.trim() !== '') {
      const search = await callRpc<unknown>(this.transport, 'session.search', { query: query.search }, signal)
      const searchRecord = recordOrUndefined(search)
      if (
        searchRecord === undefined ||
        !Array.isArray(searchRecord.items) ||
        searchRecord.items.length > 20 ||
        !searchRecord.items.every((item) => {
          const row = recordOrUndefined(item)
          return (
            row !== undefined &&
            typeof row.sessionId === 'string' &&
            row.sessionId.trim() !== '' &&
            typeof row.snippet === 'string' &&
            [...row.snippet].length <= 240
          )
        }) ||
        typeof searchRecord.hasMore !== 'boolean'
      )
        throw malformedSessionResponse('session search')
      if (searchRecord.hasMore) throw unavailable('session search continuation')
      const allowed = new Set(
        searchRecord.items.map(
          (item) => (recordOrUndefined(item) as { readonly sessionId: string }).sessionId,
        ),
      )
      items = items.filter((item) => allowed.has(item.id))
    }
    if (query?.limit !== undefined) items = items.slice(0, query.limit)
    return {
      items,
      ...(typeof list.nextCursor === 'string' && list.nextCursor.length > 0
        ? { nextCursor: list.nextCursor }
        : {}),
    }
  }

  public async get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    let summary: SessionSummary | undefined
    try {
      const page = await this.list(undefined, signal)
      summary = page.items.find((item) => item.id === sessionId)
    } catch {
      // The history endpoint is the authoritative open/read path. Keep going
      // when only the registry hint is temporarily unavailable.
    }
    const historyPages: ReturnType<typeof rc6Mapper.history>[] = []
    const rawPages: unknown[][] = []
    let beforeSeq: number | undefined
    let historyHasMore = false
    for (let page = 0; page < 100; page += 1) {
      const historyValue = await callRpc<unknown>(
        this.transport,
        'session.history',
        { sessionId, maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
        signal,
      )
      if (!validHistoryResponse(historyValue)) throw malformedSessionResponse('session history')
      const mapped = rc6Mapper.history(historyValue, sessionId)
      historyPages.push(mapped)
      rawPages.push(Array.isArray(historyValue.events) ? historyValue.events : [])
      historyHasMore = mapped.hasMore
      if (!mapped.hasMore) break
      const sequences = mapped.events.map((entry) => entry.sequence).filter((value) => value >= 0)
      const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
      if (oldest === undefined || (beforeSeq !== undefined && oldest >= beforeSeq)) break
      beforeSeq = oldest
    }
    const history = {
      events: compactHistoryEvents(
        historyPages
          .slice()
          .reverse()
          .flatMap((page) => page.events)
          .sort((left, right) => left.sequence - right.sequence),
      ),
      hasMore: historyHasMore,
      projection: historyPages[0]?.projection,
    }
    if (summary === undefined) {
      // session.list is a reconnect hint. A just-finished session can be
      // absent for one registry turn while its durable history is already
      // readable, especially while workspace attachment is being published.
      // History is the authoritative existence check for session.open.
      const cwd = historyCwd(rawPages.flat())
      let workspaceId: string | undefined
      try {
        const workspaceSnapshot = await this.workspaceRepository?.listWithArchiveState(signal)
        workspaceId = workspaceSnapshot?.items.find(
          (workspace) =>
            workspace.sessionIds?.includes(sessionId) === true ||
            (cwd !== undefined && samePath(workspace.path, cwd)),
        )?.id
      } catch {
        // A session can still be reopened from history while the workspace
        // registry is catching up; the extension performs the final scope
        // check against its current workspace snapshot.
      }
      summary = fallbackSessionSummary(
        sessionId,
        history.events,
        rawPages.flat(),
        workspaceId,
        history.projection,
      )
    }
    if (summary === undefined)
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The requested DSH session was not found.',
        retryable: true,
      })
    const permissionPresets = permissionPresetIds(history.projection?.values ?? summary.projection?.values)
    return {
      ...summary,
      configuration: configurationFromRawHistory(rawPages.slice().reverse().flat(), summary.agentPreset),
      ...(permissionPresets.length === 0 ? {} : { permissionPresets }),
      goalIds: [],
      history: history.events,
      historyHasMore: history.hasMore,
      ...(history.projection === undefined ? {} : { projection: history.projection }),
    }
  }

  public async create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail> {
    // rc.6 treats an omitted agentPreset as the deployment default.  An empty
    // value must therefore stay omitted; sending `agentPreset: ''` asks the
    // host to resolve an invalid preset id and is rejected by deployments that
    // intentionally compose no preset roster.
    const agentPreset =
      typeof input.configuration.preset === 'string' ? input.configuration.preset.trim() : ''
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'session.create',
        {
          ...(input.workspaceId.length === 0 ? {} : { workspaceId: input.workspaceId }),
          ...(agentPreset === '' ? {} : { agentPreset }),
        },
        signal,
      ),
      'session create',
    )
    const createdSessionId = requiredSessionId(value, 'session create')
    if (
      value.agentPreset !== undefined &&
      (typeof value.agentPreset !== 'string' || value.agentPreset.trim() === '')
    )
      throw malformedSessionResponse('session create receipt')
    if (input.title !== undefined && input.title.trim() !== '')
      await this.rename(createdSessionId, input.title, signal)
    if (input.configuration.model.providerId !== '' && input.configuration.model.modelId !== '')
      assertModelSelection(
        await callRpc<unknown>(
          this.transport,
          'session.selectModel',
          {
            sessionId: createdSessionId,
            provider: input.configuration.model.providerId,
            model: input.configuration.model.modelId,
            ...(input.configuration.model.reasoningLevel === undefined
              ? {}
              : { reasoningEffort: input.configuration.model.reasoningLevel }),
          },
          signal,
        ),
      )
    // `session.prompt` is an ordinary, visible user turn in rc.6.  Permission
    // and plan commands must only be sent after an explicit user action; replay
    // them while creating a session would make opening a blank session execute
    // a request before the user has typed anything.
    // Do not turn a failed authoritative read into a locally fabricated
    // session. The caller must know whether the host actually published it.
    return this.get(createdSessionId, signal)
  }

  public async remove(sessionId: string, signal?: AbortSignal): Promise<void> {
    // rc.6 has no destructive session.delete RPC. Its supported lifecycle
    // operation is the registry-global archive, which removes the session
    // from workspace listings while preserving DSH's recoverable semantics.
    await this.setArchived(sessionId, true, signal)
  }

  public async rename(sessionId: string, title: string, signal?: AbortSignal): Promise<void> {
    assertRenameReceipt(
      await callRpc<unknown>(this.transport, 'session.rename', { sessionId, title }, signal),
    )
  }

  public async fork(sessionId: string, atSeq?: number, signal?: AbortSignal): Promise<SessionDetail> {
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'session.fork',
        { sessionId, ...(atSeq === undefined ? {} : { atSeq }) },
        signal,
      ),
      'session fork',
    )
    return this.get(requiredSessionId(value, 'session fork'), signal)
  }

  public async readAttachment(
    sessionId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<PromptAttachment> {
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'session.attachment', { sessionId, attachmentId }, signal),
    )
    const reference = asRecord(value?.attachment)
    const rawData = typeof value?.data === 'string' ? value.data : ''
    const dataUri = rawData.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i)
    const mediaType = typeof reference.mediaType === 'string' ? reference.mediaType.toLowerCase() : undefined
    const encoded = dataUri?.[2] ?? rawData
    const resolvedMediaType = dataUri?.[1]?.toLowerCase() ?? mediaType
    if (
      resolvedMediaType === undefined ||
      !SUPPORTED_IMAGE_TYPES.has(resolvedMediaType) ||
      !isValidBase64(encoded) ||
      !validAttachmentReference(reference ?? {}, attachmentId)
    )
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid historical attachment.',
        retryable: false,
      })
    const bytes = Buffer.from(encoded, 'base64')
    if (
      bytes.length === 0 ||
      bytes.length > 8 * 1024 * 1024 ||
      bytes.length !== reference.bytes ||
      bytes.toString('base64') !== encoded ||
      !matchesImageSignature(resolvedMediaType, bytes)
    )
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid historical attachment.',
        retryable: false,
      })
    return {
      uri: `data:${resolvedMediaType};base64,${encoded}`,
      name: safeAttachmentName(typeof reference.name === 'string' ? reference.name : attachmentId),
      mimeType: resolvedMediaType,
    }
  }

  public async setArchived(sessionId: string, archived: boolean, signal?: AbortSignal): Promise<void> {
    if (!archived) throw unavailable('session unarchive')
    if (this.workspaceRepository !== undefined) {
      await this.workspaceRepository.archiveSession(sessionId, signal)
      return
    }
    const value = recordOrUndefined(
      await callRpc<unknown>(this.transport, 'workspace.archiveSession', { sessionId }, signal),
    )
    if (value === undefined || !isNonEmptyStringArray(value.archivedSessionIds))
      throw malformedSessionResponse('session archive receipt')
  }

  public async sendPrompt(
    input: PromptInput,
    mode: RunningInputMode = 'queue',
    signal?: AbortSignal,
  ): Promise<void> {
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.prompt',
      { sessionId: input.sessionId, mode, content: promptContent(input) },
      signal,
    )
    assertAccepted(receipt, 'session prompt')
  }

  public async enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    const beforeIds = new Set(
      (this.queues.get(input.sessionId) ?? []).filter((item) => item.mode === mode).map((item) => item.id),
    )
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.prompt',
      { sessionId: input.sessionId, mode, content: promptContent(input) },
      signal,
    )
    assertAccepted(receipt, 'session prompt')
    const queued = findNewQueuedInput(this.queues.get(input.sessionId), beforeIds, input, mode)
    if (queued !== undefined) {
      this.queueOwners.set(queued.id, input.sessionId)
      return queued
    }
    const waited = await this.waitForQueuedIdentity(input, mode, beforeIds, signal)
    if (waited !== undefined) {
      this.queueOwners.set(waited.id, input.sessionId)
      return waited
    }
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH accepted the prompt but did not publish its queue identity.',
      retryable: true,
    })
  }

  public listQueue(sessionId: string, _signal?: AbortSignal): Promise<readonly QueuedInput[]> {
    if (!this.queues.has(sessionId)) return Promise.reject(unavailable('queue snapshot'))
    const items = this.queues.get(sessionId) ?? []
    for (const item of items) this.queueOwners.set(item.id, sessionId)
    return Promise.resolve(items)
  }

  public sessionForQueuedInput(inputId: string): string | undefined {
    return this.queueOwners.get(inputId)
  }

  public async updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void> {
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.updateQueue',
      {
        sessionId: this.ownerOf(inputId),
        itemId: inputId,
        action: { kind: 'edit', content: [{ type: 'text', text }] },
      },
      signal,
    )
    assertAccepted(receipt, 'queue update')
  }

  public async removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void> {
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.updateQueue',
      { sessionId: this.ownerOf(inputId), itemId: inputId, action: { kind: 'remove' } },
      signal,
    )
    assertAccepted(receipt, 'queue removal')
    this.queueOwners.delete(inputId)
  }

  public async convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void> {
    const receipt = await callRpc<unknown>(
      this.transport,
      'session.updateQueue',
      { sessionId: this.ownerOf(inputId), itemId: inputId, action: { kind: 'steer' } },
      signal,
    )
    assertAccepted(receipt, 'queue steering')
  }

  public async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    const receipt = await callRpc<unknown>(this.transport, 'session.cancel', { sessionId }, signal)
    assertAccepted(receipt, 'session cancellation')
  }

  public async setConfiguration(
    sessionId: string,
    configuration: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<void> {
    if (configuration.toolMode !== 'native') throw unavailable('per-session tool mode')
    const hasProvider = configuration.model.providerId.trim() !== ''
    const hasModel = configuration.model.modelId.trim() !== ''
    if (hasProvider !== hasModel)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The session model selection is incomplete.',
        retryable: false,
      })
    const selectModel = async (model: {
      readonly providerId: string
      readonly modelId: string
      readonly reasoningLevel?: string
    }): Promise<void> => {
      assertModelSelection(
        await callRpc<unknown>(
          this.transport,
          'session.selectModel',
          {
            sessionId,
            provider: model.providerId,
            model: model.modelId,
            ...(model.reasoningLevel === undefined ? {} : { reasoningEffort: model.reasoningLevel }),
          },
          signal,
        ),
      )
    }
    const current = await this.get(sessionId, signal)
    const previousModel = current.configuration.model
    const modelChanged =
      hasModel &&
      (previousModel.providerId !== configuration.model.providerId ||
        previousModel.modelId !== configuration.model.modelId ||
        previousModel.reasoningLevel !== configuration.model.reasoningLevel)
    if (modelChanged) await selectModel(configuration.model)

    const requestedPreset = configuration.preset.trim()
    const currentPreset = current.configuration.preset.trim()
    if (requestedPreset !== '' && requestedPreset !== currentPreset) {
      // agentPreset.select is intentionally blank-session-only in rc.6. Do
      // not issue it against a resumed session and turn a harmless model or
      // permission change into an agent-preset-locked failure.
      if (current.status !== 'idle') throw unavailable('changing the agent preset of an existing session')
      const preset = await callRpc<unknown>(
        this.transport,
        'agentPreset.select',
        { sessionId, agentPreset: requestedPreset },
        signal,
      )
      const presetRecord = requiredRecord(preset, 'agent preset selection')
      if (typeof presetRecord.agentPreset !== 'string' || presetRecord.agentPreset.trim() === '')
        throw malformedSessionResponse('agent preset selection')
    }

    if (configuration.permissionPreset !== current.configuration.permissionPreset)
      await executeRc6Command(
        this.transport,
        sessionId,
        `/permission ${configuration.permissionPreset}`,
        signal,
      )
    if (configuration.planMode !== current.configuration.planMode)
      await executeRc6Command(
        this.transport,
        sessionId,
        configuration.planMode ? '/plan' : '/plan off',
        signal,
      )
  }

  private ownerOf(inputId: string): string {
    const sessionId = this.queueOwners.get(inputId)
    if (sessionId === undefined)
      throw new AppError({
        code: 'STALE_INTERACTION',
        message: 'The queued DSH input is no longer available.',
        retryable: true,
      })
    return sessionId
  }

  private clearQueueState(sessionId: string): void {
    this.queues.delete(sessionId)
    for (const [inputId, owner] of this.queueOwners) if (owner === sessionId) this.queueOwners.delete(inputId)
  }

  private waitForQueuedIdentity(
    input: PromptInput,
    mode: RunningInputMode,
    beforeIds: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<QueuedInput | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value: QueuedInput | undefined, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const waiters = this.queueWaiters.get(input.sessionId)
        if (waiters !== undefined) {
          waiters.delete(onQueue)
          if (waiters.size === 0) this.queueWaiters.delete(input.sessionId)
        }
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const onQueue = (items: readonly QueuedInput[]): void => {
        const candidate = findNewQueuedInput(items, beforeIds, input, mode)
        if (candidate !== undefined) finish(candidate)
      }
      const onAbort = (): void => {
        finish(
          undefined,
          new AppError({
            code: 'REQUEST_CANCELLED',
            message: 'The DSH request was cancelled.',
            retryable: false,
          }),
        )
      }
      const waiters =
        this.queueWaiters.get(input.sessionId) ?? new Set<(items: readonly QueuedInput[]) => void>()
      waiters.add(onQueue)
      this.queueWaiters.set(input.sessionId, waiters)
      const timer = setTimeout(() => finish(undefined), QUEUE_IDENTITY_TIMEOUT_MS)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined || left.trim() === '' || right.trim() === '') return false
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value))
    let canonical = resolved
    try {
      canonical = realpathSync.native(resolved)
    } catch {
      // Keep matching canonical DSH paths when a path is temporarily absent.
    }
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  return normalize(left) === normalize(right)
}

/**
 * DSH persists every streaming assistant chunk as a history event. Those
 * chunks are useful on the wire while a turn is running, but forwarding them
 * individually makes a completed session exceed the Webview protocol budget
 * and also makes history rendering look like many separate replies. Collapse
 * deltas by message while retaining their first sequence/time; a completed
 * message already carries the authoritative assembled text, so its duplicate
 * deltas are not needed by the timeline.
 */
function compactHistoryEvents(events: readonly SessionHistoryEvent[]): readonly SessionHistoryEvent[] {
  const completedMessages = new Set<string>()
  for (const entry of events) {
    const event = entry.event
    if (event.type === 'message.completed' && (event.markdown !== undefined || event.reasoning !== undefined))
      completedMessages.add(event.messageId)
  }

  const compacted: SessionHistoryEvent[] = []
  const deltaIndexes = new Map<string, number>()
  for (const entry of events) {
    const event = entry.event
    // block/tool/usage/finish chunks are stream bookkeeping. Visible tool
    // calls/results and the completed assistant message are mapped separately;
    // retaining every bookkeeping row would recreate the protocol overflow.
    if (event.type === 'unknown' && event.name.startsWith('assistant/chunk')) continue
    if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') {
      compacted.push(entry)
      continue
    }
    if (completedMessages.has(event.messageId)) continue

    const key = `${event.type}:${event.messageId}`
    const existingIndex = deltaIndexes.get(key)
    if (existingIndex === undefined) {
      deltaIndexes.set(key, compacted.length)
      compacted.push(entry)
      continue
    }
    const existing = compacted[existingIndex]
    if (existing === undefined) continue
    if (existing.event.type === 'message.delta' && event.type === 'message.delta')
      compacted[existingIndex] = {
        ...existing,
        // Keep the newest durable sequence on the compacted row. The Webview
        // uses it as its replay watermark; retaining the first sequence would
        // let a live delta already covered by history be appended twice.
        sequence: Math.max(existing.sequence, entry.sequence),
        event: { ...existing.event, delta: `${existing.event.delta}${event.delta}` },
      }
    else if (existing.event.type === 'reasoning.delta' && event.type === 'reasoning.delta')
      compacted[existingIndex] = {
        ...existing,
        sequence: Math.max(existing.sequence, entry.sequence),
        event: { ...existing.event, delta: `${existing.event.delta}${event.delta}` },
      }
  }
  return compacted
}

function fallbackSessionSummary(
  sessionId: string,
  history: readonly SessionHistoryEvent[],
  rawHistory: readonly unknown[],
  workspaceId: string | undefined,
  projectionBlock: SessionDetail['projection'] | undefined,
): SessionSummary {
  const first = history[0]?.time
  const last = history[history.length - 1]?.time
  const hasHumanMessage = history.some(
    (entry) => entry.event.type === 'message.user' && entry.event.source !== 'command',
  )
  const statusEvent = [...history].reverse().find((entry) => entry.event.type === 'session.status')?.event
  const projection = history
    .slice()
    .reverse()
    .find((entry) => entry.event.type === 'session.projection' && entry.event.key === 'title')?.event
  const projectionTitleFromEvent =
    projection?.type === 'session.projection' && typeof projection.value === 'string'
      ? projection.value.trim() || undefined
      : undefined
  const projectionTitle = firstString(projectionBlock?.values.title, projectionTitleFromEvent)
  const cwd = historyCwd(rawHistory)
  return {
    id: sessionId,
    workspaceId: workspaceId ?? '',
    ...(cwd === undefined ? {} : { cwd }),
    title: projectionTitle ?? 'New Session',
    blank: !hasHumanMessage,
    status:
      statusEvent?.type === 'session.status'
        ? statusEvent.status === 'running'
          ? 'running'
          : statusEvent.status === 'awaiting-input'
            ? 'awaiting-input'
            : statusEvent.status === 'failed'
              ? 'failed'
              : statusEvent.status === 'completed'
                ? 'completed'
                : 'idle'
        : 'completed',
    createdAt: first ?? new Date().toISOString(),
    updatedAt: last ?? first ?? new Date().toISOString(),
  }
}

function historyCwd(history: readonly unknown[]): string | undefined {
  for (const entry of history) {
    const wrapper = asRecord(entry)
    const event = asRecord(wrapper.event ?? wrapper)
    const data = asRecord(event.data)
    const header = asRecord(data.header)
    const session = asRecord(data.session)
    const meta = asRecord(data.meta)
    const cwd = firstString(data.cwd, data.workingDirectory, header.cwd, session.cwd, meta.cwd)
    if (cwd !== undefined) return cwd
  }
  return undefined
}

function promptContent(input: PromptInput): readonly Record<string, string>[] {
  let totalBytes = 0
  const content: Record<string, string>[] = [{ type: 'text', text: input.text }]
  for (const attachment of input.attachments) {
    const match = attachment.uri.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i)
    if (match === null)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment must be a supported base64 data URI.',
        retryable: false,
      })
    const mediaType = match[1]?.toLowerCase() ?? ''
    const encoded = match[2] ?? ''
    if (!isValidBase64(encoded))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment encoding is invalid.',
        retryable: false,
      })
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment encoding is not canonical Base64.',
        retryable: false,
      })
    if (bytes.length > 8 * 1024 * 1024)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment is too large.',
        retryable: false,
      })
    totalBytes += bytes.length
    if (totalBytes > 16 * 1024 * 1024)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The combined attachment size is too large.',
        retryable: false,
      })
    if (SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      if (bytes.length === 0 || !matchesImageSignature(mediaType, bytes))
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'The attachment contents do not match a supported image.',
          retryable: false,
        })
      content.push({ type: 'image', mediaType, data: encoded, name: safeAttachmentName(attachment.name) })
      continue
    }
    if (!isTextAttachment(mediaType, attachment.name, bytes))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'This DSH integration supports images and text-based files only.',
        retryable: false,
      })
    const name = safeAttachmentName(attachment.name)
    const text = bytes.toString('utf8')
    content.push({
      type: 'text',
      text: `\n\nAttached file: ${name}\n\n${text}\n\nEnd of attached file: ${name}`,
    })
  }
  return content
}

function isValidBase64(value: string): boolean {
  return value.length % 4 === 0 && (value === '' || /^[A-Za-z0-9+/]+={0,2}$/.test(value))
}

function isTextAttachment(mediaType: string, name: string, bytes: Buffer): boolean {
  if (!validTextBytes(bytes)) return false
  if (mediaType.startsWith('text/') || TEXT_ATTACHMENT_MIME_TYPES.has(mediaType)) return true
  const extension = extensionFromName(name)
  return !BINARY_ATTACHMENT_EXTENSIONS.has(extension) && TEXT_ATTACHMENT_EXTENSIONS.has(extension)
}

function validTextBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  return !bytes.toString('utf8').includes('\ufffd')
}

function extensionFromName(name: string): string {
  const baseName = name.split(/[\\/]/).pop() ?? name
  const dot = baseName.lastIndexOf('.')
  return dot <= 0 ? '' : baseName.slice(dot).toLowerCase()
}

function safeAttachmentName(name: string): string {
  const baseName = name.split(/[\\/]/).pop() ?? name
  const sanitized = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f ? ' ' : character
  })
    .join('')
    .trim()
  return (sanitized === '' ? 'file' : sanitized).slice(0, 256)
}

function matchesImageSignature(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === 'image/png')
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (mediaType === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mediaType === 'image/gif')
    return (
      bytes.length >= 6 &&
      (bytes.subarray(0, 6).toString('ascii') === 'GIF89a' ||
        bytes.subarray(0, 6).toString('ascii') === 'GIF87a')
    )
  if (mediaType === 'image/webp')
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  return false
}

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
])

const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.css',
  '.csv',
  '.go',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
  '.zsh',
])

const BINARY_ATTACHMENT_EXTENSIONS = new Set([
  '.7z',
  '.avi',
  '.bin',
  '.bz2',
  '.dll',
  '.doc',
  '.docx',
  '.exe',
  '.flac',
  '.gz',
  '.ico',
  '.jar',
  '.mp3',
  '.mp4',
  '.mov',
  '.pdf',
  '.ppt',
  '.pptx',
  '.psd',
  '.rar',
  '.tar',
  '.ttf',
  '.wav',
  '.webm',
  '.woff',
  '.woff2',
  '.xls',
  '.xlsx',
  '.zip',
])

function defaultConfiguration(): AgentConfiguration {
  return {
    preset: 'standard',
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model: { providerId: '', modelId: '' },
  }
}

function configurationFromRawHistory(history: readonly unknown[], agentPreset?: string): AgentConfiguration {
  let model = { providerId: '', modelId: '', reasoningLevel: undefined as string | undefined }
  let permissionPreset = 'workspace-write'
  let planMode = false
  let sandboxMode: string | undefined
  let approvalPolicy: string | undefined
  for (const entry of history) {
    const historyEntry = asRecord(entry)
    const event = asRecord(historyEntry.event ?? historyEntry)
    const data = asRecord(event.data)
    if (event.type === 'permission/preset') {
      const preset = firstString(data.preset, data.value, data.name, asRecord(data.permission).preset)
      if (preset !== undefined) permissionPreset = preset
      continue
    }
    if (event.type === 'plan/mode') {
      const active = booleanValue(data.active ?? data.enabled ?? data.on ?? data.value)
      if (active !== undefined) planMode = active
      else if (data.mode === 'plan' || data.mode === 'on' || data.mode === 'active') planMode = true
      else if (data.mode === 'off' || data.mode === 'normal' || data.mode === 'inactive') planMode = false
      continue
    }
    if (event.type === 'sandbox/mode') {
      const mode = firstString(data.mode, data.value, data.name)
      if (mode !== undefined) sandboxMode = mode
      continue
    }
    if (event.type === 'approval/policy') {
      const policy = firstString(data.policy, data.value, data.name)
      if (policy !== undefined) approvalPolicy = policy
      continue
    }
    if (event.type === 'request/context') {
      const provider = firstString(data.provider, data.providerId)
      const modelId = firstString(data.model, data.modelId)
      const reasoningLevel = firstString(data.reasoningEffort, data.reasoningLevel)
      model = {
        providerId: provider ?? model.providerId,
        modelId: modelId ?? model.modelId,
        reasoningLevel: reasoningLevel ?? model.reasoningLevel,
      }
      continue
    }
    if (event.type !== 'request/header') continue
    const header = asRecord(data.header)
    const config = asRecord(header.config)
    const providerId = typeof config.provider === 'string' ? config.provider : model.providerId
    const modelId = typeof config.model === 'string' ? config.model : model.modelId
    const reasoningLevel =
      typeof config.reasoningEffort === 'string' ? config.reasoningEffort : model.reasoningLevel
    model = { providerId, modelId, reasoningLevel }
  }
  return {
    ...defaultConfiguration(),
    ...(agentPreset === undefined ? {} : { preset: agentPreset }),
    permissionPreset,
    planMode,
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    model: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.reasoningLevel === undefined ? {} : { reasoningLevel: model.reasoningLevel }),
    },
  }
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformedSessionResponse(method: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed ${method} response.`,
    retryable: false,
  })
}

function requiredRecord(value: unknown, method: string): Record<string, unknown> {
  const record = recordOrUndefined(value)
  if (record !== undefined) return record
  throw malformedSessionResponse(method)
}

function requiredSessionId(value: Record<string, unknown>, method: string): string {
  if (typeof value.sessionId === 'string' && value.sessionId.trim() !== '') return value.sessionId
  throw malformedSessionResponse(`${method} receipt`)
}

function assertRenameReceipt(value: unknown): void {
  const record = recordOrUndefined(value)
  if (
    record !== undefined &&
    typeof record.title === 'string' &&
    record.title.trim() !== '' &&
    Number.isSafeInteger(record.seq) &&
    (record.seq as number) >= 0
  )
    return
  throw malformedSessionResponse('session rename receipt')
}

function assertModelSelection(value: unknown): void {
  const selected = recordOrUndefined(recordOrUndefined(value)?.selected)
  if (
    selected !== undefined &&
    typeof selected.provider === 'string' &&
    selected.provider.trim() !== '' &&
    typeof selected.model === 'string' &&
    selected.model.trim() !== '' &&
    (selected.reasoningEffort === undefined || isNonEmptyString(selected.reasoningEffort))
  )
    return
  throw malformedSessionResponse('session model selection receipt')
}

function validSessionSummaryResponse(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    typeof record.sessionId === 'string' &&
    record.sessionId.trim() !== '' &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    record.updatedAt >= 0 &&
    typeof record.running === 'boolean' &&
    typeof record.blank === 'boolean' &&
    (record.workspaceId === undefined || typeof record.workspaceId === 'string') &&
    (record.parentSessionId === undefined ||
      (typeof record.parentSessionId === 'string' && record.parentSessionId.trim() !== '')) &&
    (record.origin === undefined || record.origin === 'subagent') &&
    (record.cwd === undefined || typeof record.cwd === 'string') &&
    (record.agentPreset === undefined || typeof record.agentPreset === 'string') &&
    (record.projections === undefined || validProjectionBlock(record.projections))
  )
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry): entry is string => isNonEmptyString(entry))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validHistoryResponse(
  value: unknown,
): value is { readonly events: unknown[]; readonly hasMore: boolean } {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    Array.isArray(record.events) &&
    record.events.every(validHistoryEntry) &&
    typeof record.hasMore === 'boolean' &&
    (record.projections === undefined || validProjectionBlock(record.projections))
  )
}

function validHistoryEntry(value: unknown): boolean {
  const entry = recordOrUndefined(value)
  const event = recordOrUndefined(entry?.event)
  return (
    entry !== undefined &&
    event !== undefined &&
    typeof event.type === 'string' &&
    event.type.trim() !== '' &&
    Number.isSafeInteger(event.seq) &&
    (event.seq as number) >= 0 &&
    typeof event.time === 'number' &&
    Number.isFinite(event.time) &&
    (entry.view === undefined || recordOrUndefined(entry.view) !== undefined)
  )
}

function validAttachmentReference(value: Record<string, unknown>, requestedId: string): boolean {
  return (
    typeof value.attachmentId === 'string' &&
    value.attachmentId === requestedId &&
    typeof value.mediaType === 'string' &&
    SUPPORTED_IMAGE_TYPES.has(value.mediaType.toLowerCase()) &&
    Number.isSafeInteger(value.bytes) &&
    (value.bytes as number) > 0 &&
    Number.isSafeInteger(value.width) &&
    (value.width as number) > 0 &&
    Number.isSafeInteger(value.height) &&
    (value.height as number) > 0 &&
    (value.name === undefined || typeof value.name === 'string')
  )
}

function validProjectionBlock(value: unknown): boolean {
  const record = recordOrUndefined(value)
  return (
    record !== undefined &&
    Number.isSafeInteger(record.asOfSeq) &&
    (record.asOfSeq as number) >= -1 &&
    recordOrUndefined(record.values) !== undefined
  )
}

function findNewQueuedInput(
  items: readonly QueuedInput[] | undefined,
  beforeIds: ReadonlySet<string>,
  input: PromptInput,
  mode: RunningInputMode,
): QueuedInput | undefined {
  const candidates = [...(items ?? [])]
    .reverse()
    .filter((item) => !beforeIds.has(item.id) && item.mode === mode)
  return (
    candidates.find((item) => item.text === input.text) ??
    (input.attachments.length > 0 ? candidates[0] : undefined)
  )
}

const QUEUE_IDENTITY_TIMEOUT_MS = 2_000

function assertAccepted(value: unknown, method: string): void {
  if (asRecord(value).accepted === true) return
  throw malformedSessionResponse(`${method} receipt`)
}
