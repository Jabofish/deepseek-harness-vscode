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
  type SessionHistoryPage,
  type SessionListQuery,
  type SessionPage,
  type SessionRepository,
  type SessionSummary,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { executeRc6Command } from './command-repository.js'
import { callRpc, type RpcResponseLike, unavailable, unwrapRpcResult } from '../versions/rc6/rpc.js'
import { permissionPresetIds, rc6Mapper } from '../versions/rc6/mapper.js'
import type { Rc6WorkspaceRepository } from './workspace-repository.js'

const MAX_PROMPT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024

export class Rc6SessionRepository implements SessionRepository {
  private readonly queueOwners = new Map<string, string>()
  private readonly queues = new Map<string, readonly QueuedInput[]>()
  private readonly queueWaiters = new Map<string, Set<(items: readonly QueuedInput[]) => void>>()
  private readonly pendingQueueIdentities = new Map<string, Promise<QueuedInput | undefined>>()
  public constructor(
    private readonly transport: DshTransport,
    private readonly workspaceRepository?: Rc6WorkspaceRepository,
    private readonly pathComparator: ((left: string, right: string) => boolean) | undefined = undefined,
    options: SessionRepositoryOptions = {},
  ) {
    this.supportsPreallocatedSessionId =
      options.preallocatedSessionId === true || options.reuseWorkspaceBlank === true
    this.supportsWorkspaceBlankReuse = options.reuseWorkspaceBlank === true
    this.maxPromptAttachmentBytes = options.maxPromptAttachmentBytes ?? MAX_PROMPT_ATTACHMENT_BYTES
    this.maxPromptAttachmentTotalBytes =
      options.maxPromptAttachmentTotalBytes ?? MAX_PROMPT_ATTACHMENT_TOTAL_BYTES
  }

  private readonly supportsPreallocatedSessionId: boolean
  private readonly supportsWorkspaceBlankReuse: boolean
  private readonly maxPromptAttachmentBytes: number
  private readonly maxPromptAttachmentTotalBytes: number

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
    if (query?.archived !== undefined && this.workspaceRepository === undefined)
      throw unavailable('archived session listing without workspace state')
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
          workspaces.find(
            (workspace) => item.cwd !== undefined && samePath(workspace.path, item.cwd, this.pathComparator),
          )?.id
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
    const firstPage = await this.readHistoryPage(sessionId, undefined, signal)
    const history = firstPage.page
    const rawHistory = firstPage.rawEvents
    if (summary === undefined) {
      // session.list is a reconnect hint. A just-finished session can be
      // absent for one registry turn while its durable history is already
      // readable, especially while workspace attachment is being published.
      // History is the authoritative existence check for session.open.
      const cwd = historyCwd(rawHistory)
      let workspaceId: string | undefined
      try {
        const workspaceSnapshot = await this.workspaceRepository?.listWithArchiveState(signal)
        workspaceId = workspaceSnapshot?.items.find(
          (workspace) =>
            workspace.sessionIds?.includes(sessionId) === true ||
            (cwd !== undefined && samePath(workspace.path, cwd, this.pathComparator)),
        )?.id
      } catch {
        // A session can still be reopened from history while the workspace
        // registry is catching up; the extension performs the final scope
        // check against its current workspace snapshot.
      }
      summary = fallbackSessionSummary(sessionId, history.events, rawHistory, workspaceId, history.projection)
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
      configuration: configurationFromRawHistory(rawHistory, summary.agentPreset),
      ...(permissionPresets.length === 0 ? {} : { permissionPresets }),
      goalIds: [],
      history: history.events,
      historyHasMore: history.hasMore,
      ...(history.beforeSequence === undefined ? {} : { historyBeforeSequence: history.beforeSequence }),
      ...(history.projection === undefined ? {} : { projection: history.projection }),
    }
  }

  public async history(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ): Promise<SessionHistoryPage> {
    return (await this.readHistoryPage(sessionId, beforeSequence, signal)).page
  }

  private async readHistoryPage(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ): Promise<{ readonly page: SessionHistoryPage; readonly rawEvents: readonly unknown[] }> {
    const historyValue = await callRpc<unknown>(
      this.transport,
      'session.history',
      { sessionId, maxMessages: 200, ...(beforeSequence === undefined ? {} : { beforeSeq: beforeSequence }) },
      signal,
    )
    if (!validHistoryResponse(historyValue)) throw malformedSessionResponse('session history')
    const mapped = rc6Mapper.history(historyValue, sessionId)
    const rawEvents = Array.isArray(historyValue.events) ? historyValue.events : []
    const sequences = mapped.events.map((entry) => entry.sequence).filter((value) => value >= 0)
    const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
    return {
      page: {
        events: compactHistoryEvents(mapped.events),
        hasMore: mapped.hasMore,
        ...(oldest === undefined ? {} : { beforeSequence: oldest }),
        ...(mapped.projection === undefined ? {} : { projection: mapped.projection }),
      },
      rawEvents,
    }
  }

  public async create(input: SessionCreateInput, signal?: AbortSignal): Promise<SessionDetail> {
    // rc.6 treats an omitted agentPreset as the deployment default.  An empty
    // value must therefore stay omitted; sending `agentPreset: ''` asks the
    // host to resolve an invalid preset id and is rejected by deployments that
    // intentionally compose no preset roster.
    const reusableSessionId =
      this.supportsPreallocatedSessionId &&
      typeof input.sessionId === 'string' &&
      input.sessionId.trim() !== ''
        ? input.sessionId
        : undefined
    const reusingWorkspaceBlank =
      this.supportsWorkspaceBlankReuse &&
      reusableSessionId !== undefined &&
      input.reuseWorkspaceBlank === true
    const agentPreset = reusingWorkspaceBlank
      ? ''
      : typeof input.configuration.preset === 'string'
        ? input.configuration.preset.trim()
        : ''
    const value = requiredRecord(
      await callRpc<unknown>(
        this.transport,
        'session.create',
        {
          ...(input.workspaceId.length === 0 ? {} : { workspaceId: input.workspaceId }),
          ...(reusableSessionId === undefined ? {} : { sessionId: reusableSessionId }),
          ...(reusingWorkspaceBlank ? { reuseWorkspaceBlank: true } : {}),
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
      bytes.length > this.maxPromptAttachmentBytes ||
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
      {
        sessionId: input.sessionId,
        mode,
        content: promptContent(input, this.maxPromptAttachmentBytes, this.maxPromptAttachmentTotalBytes),
      },
      signal,
    )
    assertAccepted(receipt, 'session prompt')
  }

  public async enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    const promptKey = queuedPromptKey(input, mode)
    const pending = this.pendingQueueIdentities.get(promptKey)
    if (pending !== undefined) {
      const queued = await this.awaitQueueIdentity(pending, signal, QUEUE_IDENTITY_GRACE_MS)
      if (queued !== undefined) {
        this.queueOwners.set(queued.id, input.sessionId)
        return queued
      }
      if (this.pendingQueueIdentities.get(promptKey) === pending)
        this.pendingQueueIdentities.delete(promptKey)
    }
    const beforeIds = new Set(
      (this.queues.get(input.sessionId) ?? []).filter((item) => item.mode === mode).map((item) => item.id),
    )
    const response = await this.transport.request<RpcResponseLike<unknown>>(
      'session.prompt',
      {
        sessionId: input.sessionId,
        mode,
        content: promptContent(input, this.maxPromptAttachmentBytes, this.maxPromptAttachmentTotalBytes),
      },
      signal,
    )
    const receipt = unwrapRpcResult(response, 'session.prompt')
    assertAccepted(receipt, 'session prompt')
    const queued = findNewQueuedInput(
      this.queues.get(input.sessionId),
      beforeIds,
      input,
      mode,
      response.rpcId,
    )
    if (queued !== undefined) {
      this.queueOwners.set(queued.id, input.sessionId)
      return queued
    }
    const identityPromise = this.waitForQueuedIdentity(
      input,
      mode,
      beforeIds,
      response.rpcId,
      QUEUE_IDENTITY_GRACE_MS,
    )
    this.pendingQueueIdentities.set(promptKey, identityPromise)
    void identityPromise.then(
      (resolved) => {
        if (this.pendingQueueIdentities.get(promptKey) === identityPromise)
          this.pendingQueueIdentities.delete(promptKey)
        if (resolved !== undefined) this.queueOwners.set(resolved.id, input.sessionId)
      },
      () => {
        if (this.pendingQueueIdentities.get(promptKey) === identityPromise)
          this.pendingQueueIdentities.delete(promptKey)
      },
    )
    const waited = await this.awaitQueueIdentity(identityPromise, signal, QUEUE_IDENTITY_TIMEOUT_MS)
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
    const requestedPermission = configuration.permissionPreset.trim()
    if (!isPermissionPresetId(requestedPermission))
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The session permission preset is invalid.',
        retryable: false,
      })
    const current = await this.get(sessionId, signal)
    const currentPermission = current.configuration.permissionPreset.trim()
    if (
      requestedPermission !== currentPermission &&
      current.permissionPresets !== undefined &&
      current.permissionPresets.length > 0 &&
      !current.permissionPresets.includes(requestedPermission)
    )
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The requested session permission preset is not advertised by DSH.',
        retryable: false,
      })

    const requestedPreset = configuration.preset.trim()
    const currentPreset = current.configuration.preset.trim()
    if (requestedPreset !== '' && requestedPreset !== currentPreset && current.status !== 'idle')
      throw unavailable('changing the agent preset of an existing session')

    const selectModel = async (
      model: {
        readonly providerId: string
        readonly modelId: string
        readonly reasoningLevel?: string
      },
      operationSignal?: AbortSignal,
    ): Promise<void> => {
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
          operationSignal,
        ),
      )
    }
    const previousModel = current.configuration.model
    const modelChanged =
      hasModel &&
      (previousModel.providerId !== configuration.model.providerId ||
        previousModel.modelId !== configuration.model.modelId ||
        previousModel.reasoningLevel !== configuration.model.reasoningLevel)
    const rollback: Array<() => Promise<void>> = []
    const apply = async (forward: () => Promise<void>, reverse: () => Promise<void>): Promise<void> => {
      await forward()
      rollback.unshift(reverse)
    }
    const selectPreset = async (preset: string, operationSignal?: AbortSignal): Promise<void> => {
      const value = await callRpc<unknown>(
        this.transport,
        'agentPreset.select',
        { sessionId, agentPreset: preset },
        operationSignal,
      )
      const presetRecord = requiredRecord(value, 'agent preset selection')
      if (typeof presetRecord.agentPreset !== 'string' || presetRecord.agentPreset.trim() === '')
        throw malformedSessionResponse('agent preset selection')
    }
    const command = async (value: string, operationSignal?: AbortSignal): Promise<void> => {
      await executeRc6Command(this.transport, sessionId, value, operationSignal)
    }

    try {
      // DSH exposes independent mutation RPCs rather than a transaction. Apply
      // the cheap host-validated settings first and keep explicit compensating
      // actions so a later failure does not leave a mixed configuration.
      if (requestedPreset !== '' && requestedPreset !== currentPreset)
        await apply(
          () => selectPreset(requestedPreset, signal),
          () => (currentPreset === '' ? Promise.resolve() : selectPreset(currentPreset)),
        )
      if (requestedPermission !== currentPermission)
        await apply(
          () => command(`/permission ${requestedPermission}`, signal),
          () =>
            isPermissionPresetId(currentPermission)
              ? command(`/permission ${currentPermission}`)
              : Promise.resolve(),
        )
      if (configuration.planMode !== current.configuration.planMode)
        await apply(
          () => command(configuration.planMode ? '/plan' : '/plan off', signal),
          () => command(current.configuration.planMode ? '/plan' : '/plan off'),
        )
      if (modelChanged)
        await apply(
          () => selectModel(configuration.model, signal),
          () =>
            previousModel.providerId.trim() !== '' && previousModel.modelId.trim() !== ''
              ? selectModel(previousModel)
              : Promise.resolve(),
        )
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const undo of rollback) {
        try {
          await undo()
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0)
        throw new AppError({
          code: 'INTERNAL_ERROR',
          message: 'DSH configuration failed and could not be fully restored.',
          retryable: true,
          cause: new AggregateError([error, ...rollbackErrors]),
        })
      throw error
    }
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
    const prefix = `${sessionId}\u0000`
    for (const key of this.pendingQueueIdentities.keys())
      if (key.startsWith(prefix)) this.pendingQueueIdentities.delete(key)
  }

  private waitForQueuedIdentity(
    input: PromptInput,
    mode: RunningInputMode,
    beforeIds: ReadonlySet<string>,
    rpcId: string | undefined,
    timeoutMs: number,
  ): Promise<QueuedInput | undefined> {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: QueuedInput | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const waiters = this.queueWaiters.get(input.sessionId)
        if (waiters !== undefined) {
          waiters.delete(onQueue)
          if (waiters.size === 0) this.queueWaiters.delete(input.sessionId)
        }
        resolve(value)
      }
      const onQueue = (items: readonly QueuedInput[]): void => {
        const candidate = findNewQueuedInput(items, beforeIds, input, mode, rpcId)
        if (candidate !== undefined) finish(candidate)
      }
      const waiters =
        this.queueWaiters.get(input.sessionId) ?? new Set<(items: readonly QueuedInput[]) => void>()
      waiters.add(onQueue)
      this.queueWaiters.set(input.sessionId, waiters)
      const timer = setTimeout(() => finish(undefined), timeoutMs)
    })
  }

  private awaitQueueIdentity(
    promise: Promise<QueuedInput | undefined>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<QueuedInput | undefined> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value: QueuedInput | undefined, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error === undefined) resolve(value)
        else reject(error)
      }
      const onAbort = (): void =>
        finish(
          undefined,
          new AppError({
            code: 'REQUEST_CANCELLED',
            message: 'The DSH request was cancelled.',
            retryable: false,
          }),
        )
      const timer = setTimeout(() => finish(undefined), timeoutMs)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => finish(value),
        (error: unknown) =>
          finish(undefined, error instanceof Error ? error : new Error('Queue identity failed.')),
      )
    })
  }
}

interface SessionRepositoryOptions {
  /** rc.2 accepts an idempotency/preallocated sessionId without rc.1's reuse flag. */
  readonly preallocatedSessionId?: boolean
  readonly reuseWorkspaceBlank?: boolean
  /** rc.2 raises the DSH image envelope to 20 MiB per image / 200 MiB per message. */
  readonly maxPromptAttachmentBytes?: number
  readonly maxPromptAttachmentTotalBytes?: number
}

function samePath(
  left: string | undefined,
  right: string | undefined,
  comparator?: (left: string, right: string) => boolean,
): boolean {
  if (left === undefined || right === undefined || left.trim() === '' || right.trim() === '') return false
  if (comparator !== undefined) return comparator(left, right)
  return normalizePath(left) === normalizePath(right)
}

/**
 * Tests and non-VS Code consumers still get useful matching without making
 * the adapter call a platform filesystem. The Extension Host injects the
 * canonical realpath comparator for production workspace matching.
 */
function normalizePath(value: string): string {
  const segments: string[] = []
  for (const segment of value.trim().replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/').toLocaleLowerCase()
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

function promptContent(
  input: PromptInput,
  maxImageBytes: number,
  maxAttachmentTotalBytes: number,
): readonly Record<string, string>[] {
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
    const maxBytes = SUPPORTED_IMAGE_TYPES.has(mediaType) ? maxImageBytes : MAX_PROMPT_ATTACHMENT_BYTES
    if (bytes.length > maxBytes)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The attachment is too large.',
        retryable: false,
      })
    totalBytes += bytes.length
    if (totalBytes > maxAttachmentTotalBytes)
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
  rpcId?: string,
): QueuedInput | undefined {
  const candidates = [...(items ?? [])]
    .reverse()
    .filter((item) => !beforeIds.has(item.id) && item.mode === mode)
  if (rpcId !== undefined) {
    const correlated = candidates.find((item) => item.rpcId === rpcId)
    if (correlated !== undefined) return correlated
  }
  return (
    candidates.find((item) => item.text === input.text) ??
    (input.attachments.length > 0 ? candidates[0] : undefined)
  )
}

const QUEUE_IDENTITY_TIMEOUT_MS = 2_000
const QUEUE_IDENTITY_GRACE_MS = 30_000

function queuedPromptKey(input: PromptInput, mode: RunningInputMode): string {
  const value = `${mode}\u0000${input.text}\u0000${input.attachments
    .map((attachment) => `${attachment.name}\u0000${attachment.mimeType ?? ''}\u0000${attachment.uri}`)
    .join('\u0001')}`
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${input.sessionId}\u0000${mode}\u0000${hash >>> 0}`
}

function assertAccepted(value: unknown, method: string): void {
  if (asRecord(value).accepted === true) return
  throw malformedSessionResponse(`${method} receipt`)
}

function isPermissionPresetId(value: string): boolean {
  // rc.6 exposes this as a one-token slash command. Reject control/whitespace
  // and separators before any other setting is mutated.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
}
