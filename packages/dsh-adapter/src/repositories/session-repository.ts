import {
  AppError,
  type AgentConfiguration,
  type BackendEvent,
  type ImageAttachmentLimits,
  type PromptAttachment,
  type PromptInput,
  type QueuedInput,
  type RunningInputMode,
  type SessionCreateInput,
  type SessionDetail,
  type SessionHistoryPage,
  type SessionHistoryQueryOptions,
  type SessionListQuery,
  type SessionPage,
  type SessionRepository,
  type SessionSummary,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import type { CommandAttachmentWire } from './command-repository.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import { rc6Mapper } from '../versions/rc6/mapper.js'
import { permissionPresetIds } from '../projection/agent.js'
import type { Rc6WorkspaceRepository } from './workspace-repository.js'
import { recordOrUndefined } from './shared/guards.js'
import {
  decodeBase64Payload,
  isSupportedImageMimeType,
  matchesImageSignature,
  parseBase64DataUri,
  safeAttachmentName,
  type PromptContentLimits,
} from '../attachment-codec.js'
import type { Rc6SessionRepositoryOptions } from './session/options.js'
import { setSessionConfiguration } from './session/set-configuration.js'
import { SessionPromptQueue } from './session/prompt-queue.js'
import { samePath } from './session/path.js'
import {
  compactHistoryEvents,
  fallbackSessionSummary,
  historyCwd,
  sequenceRanges,
} from './session/history.js'
import { asRecord, configurationFromRawHistory, firstString } from './session/configuration.js'
import { parseImageAttachmentLimits } from './session/image-limits.js'
import {
  acceptedRenameTitle,
  assertModelSelection,
  isNonEmptyStringArray,
  malformedSessionResponse,
  requiredRecord,
  requiredSessionId,
  validAttachmentReference,
  validHistoryResponse,
  validSessionSummaryResponse,
} from './session/responses.js'
import { assertAccepted } from './session/queue-helpers.js'

/** The official web client pages session.history at 50 messages per read. */
const HISTORY_PAGE_MESSAGES = 50
const MAX_PROMPT_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 100 * 1024 * 1024

function validHistoryPageSize(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 500)
    : HISTORY_PAGE_MESSAGES
}

export class Rc6SessionRepository implements SessionRepository {
  /** The list projection is a hint that can be reused by the following open.
   * The history page remains the authoritative payload; keeping this local
   * hint avoids issuing a second session.list just to recover title/status. */
  private readonly sessionSummaries = new Map<string, SessionSummary>()
  private readonly promptQueue: SessionPromptQueue
  private readonly imageLimitsBySession = new Map<string, ImageAttachmentLimits>()
  public constructor(
    private readonly transport: DshTransport,
    private readonly workspaceRepository?: Rc6WorkspaceRepository,
    private readonly pathComparator: ((left: string, right: string) => boolean) | undefined = undefined,
    options: Rc6SessionRepositoryOptions = {},
  ) {
    this.supportsPreallocatedSessionId =
      options.preallocatedSessionId === true || options.reuseWorkspaceBlank === true
    this.supportsWorkspaceBlankReuse = options.reuseWorkspaceBlank === true
    this.commandAttachmentWire = options.commandAttachmentWire ?? 'none'
    this.maxPromptAttachmentBytes = options.maxPromptAttachmentBytes ?? MAX_PROMPT_ATTACHMENT_BYTES
    this.maxPromptAttachmentTotalBytes =
      options.maxPromptAttachmentTotalBytes ?? MAX_PROMPT_ATTACHMENT_TOTAL_BYTES
    this.onSessionAccess = options.onSessionAccess
    this.onSessionOpen = options.onSessionOpen
    this.deriveTitleFromCwd = options.deriveTitleFromCwd === true
    this.queueBaseline = options.queueBaseline ?? 'subscription'
    this.includesClientTimeZone = options.includeClientTimeZone ?? true
    this.executeSessionConfigurationCommand = options.executeSessionConfigCommand
    this.selectAgentPreset = options.selectAgentPreset
    this.readPermissionPresets = options.readPermissionPresets
    this.supportsFileUploads = options.supportsFileUploads === true
    this.supportsSessionRestore = options.supportsSessionRestore === true
    this.promptQueue = new SessionPromptQueue(
      this.transport,
      this.queueBaseline,
      this.includesClientTimeZone,
      this.onSessionAccess,
      (sessionId) => this.promptContentLimits(sessionId),
    )
  }

  private readonly readPermissionPresets: ((signal?: AbortSignal) => Promise<readonly string[]>) | undefined
  public readonly supportsFileUploads: boolean
  private readonly supportsSessionRestore: boolean
  private readonly supportsPreallocatedSessionId: boolean
  private readonly supportsWorkspaceBlankReuse: boolean
  private readonly commandAttachmentWire: CommandAttachmentWire
  private readonly maxPromptAttachmentBytes: number
  private readonly maxPromptAttachmentTotalBytes: number
  private readonly onSessionAccess: ((sessionId: string) => void) | undefined
  private readonly onSessionOpen: ((sessionId: string) => void | Promise<void>) | undefined
  private readonly deriveTitleFromCwd: boolean
  private readonly queueBaseline: 'subscription' | 'control' | 'control-follow'
  private readonly includesClientTimeZone: boolean
  private readonly executeSessionConfigurationCommand:
    ((sessionId: string, command: string, signal?: AbortSignal) => Promise<void>) | undefined
  private readonly selectAgentPreset:
    ((sessionId: string, presetId: string, signal?: AbortSignal) => Promise<void>) | undefined

  public remember(event: BackendEvent): void {
    this.promptQueue.remember(event)
    if (event.type === 'session.subscribed') {
      this.rememberProjectionValues(event.sessionId, event.projection?.values, true)
    } else if (event.type === 'session.removed') {
      this.imageLimitsBySession.delete(event.sessionId)
      this.sessionSummaries.delete(event.sessionId)
    } else if (event.type === 'session.projection' && event.key === 'imageLimits') {
      this.rememberImageLimitsValue(event.sessionId, event.value)
    }
  }
  public async list(query?: SessionListQuery, signal?: AbortSignal): Promise<SessionPage> {
    if (query?.cursor !== undefined && query.cursor.trim() !== '')
      throw unavailable('session list pagination')
    if (query?.archived !== undefined && this.workspaceRepository === undefined)
      throw unavailable('archived session listing without workspace state')
    const value = await callRpc<unknown>(
      this.transport,
      'session.list',
      {
        ...(query?.cursor === undefined || query.cursor.trim() === '' ? {} : { cursor: query.cursor }),
      },
      signal,
    )
    const list = requiredRecord(value, 'session list')
    if (
      !Array.isArray(list.items) ||
      !list.items.every(validSessionSummaryResponse) ||
      (list.nextCursor !== undefined && typeof list.nextCursor !== 'string')
    )
      throw malformedSessionResponse('session list')
    let items = list.items.map((item) => {
      const mapped = rc6Mapper.sessionSummary(item)
      // session.list carries a partial, possibly stale hint. Only a history
      // baseline or session.subscribed projection may clear omitted cells.
      this.rememberProjectionValues(mapped.id, mapped.projection?.values)
      return mapped
    })
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
    let searchHasMore: boolean | undefined
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
      // The search contract caps this result and reports whether additional
      // authorized matches exist. Keep the partial result and carry that fact
      // to the UI so it can ask the user to refine the query.
      const allowed = new Set(
        searchRecord.items.map(
          (item) => (recordOrUndefined(item) as { readonly sessionId: string }).sessionId,
        ),
      )
      items = items.filter((item) => allowed.has(item.id))
      searchHasMore = searchRecord.hasMore
    }
    if (query?.limit !== undefined) {
      if (searchHasMore !== undefined && items.length > query.limit) searchHasMore = true
      items = items.slice(0, query.limit)
    }
    for (const item of items) this.sessionSummaries.set(item.id, item)
    return {
      items,
      ...(typeof list.nextCursor === 'string' && list.nextCursor.length > 0
        ? { nextCursor: list.nextCursor }
        : {}),
      ...(searchHasMore === undefined ? {} : { searchHasMore }),
    }
  }

  public async get(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    this.onSessionAccess?.(sessionId)
    // Do not turn session.open into session.list + session.history. The
    // upstream history endpoint is the authoritative read path, and the list
    // projection is already cached when the switcher has loaded it.
    let summary = this.sessionSummaries.get(sessionId)
    const firstPage = await this.readHistoryPage(sessionId, undefined, signal, { pagePurpose: 'transcript' })
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
      summary = fallbackSessionSummary(
        sessionId,
        history.events,
        rawHistory,
        workspaceId,
        history.projection,
        this.deriveTitleFromCwd,
      )
    }
    if (summary === undefined)
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The requested DSH session was not found.',
        retryable: true,
      })
    // A history projection is an exact durable cut. Do not merge it with an
    // older list hint: omitted keys in the authoritative baseline mean that
    // the capability is absent at this cut, not that the hint should survive.
    const projectionValues = history.projection?.values ?? summary.projection?.values ?? {}
    this.rememberProjectionValues(sessionId, projectionValues, history.projection !== undefined)
    const projectedPresets = permissionPresetIds(projectionValues)
    let permissionPresets = projectedPresets
    if (projectedPresets !== undefined && this.readPermissionPresets !== undefined) {
      try {
        permissionPresets = await this.readPermissionPresets(signal)
      } catch (error) {
        if (signal?.aborted === true || (error instanceof AppError && error.code === 'REQUEST_CANCELLED'))
          throw error
        // The catalog is optional enrichment. Preserve the current permission
        // from the history projection, but offer no unverified alternatives.
        permissionPresets = []
      }
    }
    const agentPreset = firstString(summary.agentPreset, projectionValues.agentPreset)
    const projection = history.projection ?? summary.projection
    return {
      ...summary,
      configuration: configurationFromRawHistory(rawHistory, agentPreset, projectionValues),
      ...(permissionPresets === undefined ? {} : { permissionPresets }),
      history: history.events,
      historyHasMore: history.hasMore,
      ...(history.beforeSequence === undefined ? {} : { historyBeforeSequence: history.beforeSequence }),
      ...(projection === undefined ? {} : { projection }),
    }
  }

  public async open(sessionId: string, signal?: AbortSignal): Promise<SessionDetail> {
    const detail = await this.get(sessionId, signal)
    // Re-baseline after the authoritative history read. This ensures a
    // process-local alpha13 assistant snapshot cannot predate the durable cut
    // returned by session.open, while still restoring transient chunks that
    // were produced during the read.
    await this.onSessionOpen?.(sessionId)
    return detail
  }

  public async history(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
    options?: SessionHistoryQueryOptions,
  ): Promise<SessionHistoryPage> {
    return (await this.readHistoryPage(sessionId, beforeSequence, signal, options)).page
  }

  /**
   * Return an un-compacted, prompt-free marker stream for durable gap healing.
   * This is intentionally outside SessionRepository: the Webview must keep
   * using the bounded presentation history, while the stream dispatcher needs
   * every durable sequence to distinguish a real hole from UI compaction.
   */
  public async historyForRecovery(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ): Promise<SessionHistoryPage> {
    return (
      await this.readHistoryPage(sessionId, beforeSequence, signal, {
        compact: false,
        includeSystemMarkers: true,
      })
    ).page
  }

  private async readHistoryPage(
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
    options: {
      readonly compact?: boolean
      readonly includeSystemMarkers?: boolean
      readonly pageSize?: number
      readonly pagePurpose?: SessionHistoryQueryOptions['pagePurpose']
    } = {},
  ): Promise<{ readonly page: SessionHistoryPage; readonly rawEvents: readonly unknown[] }> {
    const useTurnWindow =
      options.pagePurpose === 'transcript' && this.transport.sessionHistoryTurnWindow === true
    const requestedPageSize = validHistoryPageSize(options.pageSize)
    const historyValue = await callRpc<unknown>(
      this.transport,
      'session.history',
      {
        sessionId,
        maxMessages: useTurnWindow ? 500 : requestedPageSize,
        ...(useTurnWindow ? { turnWindow: { minMessages: requestedPageSize, minTurns: 2 } } : {}),
        ...(beforeSequence === undefined ? {} : { beforeSeq: beforeSequence }),
      },
      signal,
    )
    if (!validHistoryResponse(historyValue)) throw malformedSessionResponse('session history')
    // Always map the internal marker rows while calculating the raw page
    // boundary. A public page omits the prompt marker, but its cursor must
    // still point at the real oldest durable record or pagination can stall
    // on a page whose first record is system/message.
    const mapped = rc6Mapper.history(historyValue, sessionId, { includeSystemMarkers: true })
    this.rememberProjectionValues(sessionId, mapped.projection?.values, mapped.projection !== undefined)
    const rawEvents = Array.isArray(historyValue.events) ? historyValue.events : []
    const sequences = mapped.events.map((entry) => entry.sequence).filter((value) => value >= 0)
    const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
    const coveredSequenceRanges = sequenceRanges(sequences)
    const events =
      options.includeSystemMarkers === true
        ? mapped.events
        : mapped.events.filter((entry) => entry.event.type !== 'session.system')
    return {
      page: {
        events: options.compact === false ? events : compactHistoryEvents(events),
        hasMore: mapped.hasMore,
        ...(oldest === undefined ? {} : { beforeSequence: oldest }),
        ...(coveredSequenceRanges.length === 0 ? {} : { coveredSequenceRanges }),
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
      await this.createSession(
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
    const attachmentFailed = value.attachmentFailed === true
    if (
      !attachmentFailed &&
      value.agentPreset !== undefined &&
      (typeof value.agentPreset !== 'string' || value.agentPreset.trim() === '')
    )
      throw malformedSessionResponse('session create receipt')
    if (!attachmentFailed && input.title !== undefined && input.title.trim() !== '')
      await this.rename(createdSessionId, input.title, signal)
    if (
      !attachmentFailed &&
      input.configuration.model.providerId !== '' &&
      input.configuration.model.modelId !== ''
    )
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

  /**
   * `workspace-attach-failed` still leaves a published session on the host;
   * the official client surfaces it as ungrouped instead of losing it. Read
   * it back through the history path so the caller can open the real session
   * and retry attachment later.
   */
  private async createSession(
    payload: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await callRpc<unknown>(this.transport, 'session.create', payload, signal)
    } catch (error) {
      if (
        error instanceof AppError &&
        error.context?.rpcCode === 'workspace-attach-failed' &&
        typeof error.context.publishedSessionId === 'string'
      )
        return { sessionId: error.context.publishedSessionId, attachmentFailed: true }
      throw error
    }
  }

  public remove(_sessionId: string, _signal?: AbortSignal): Promise<void> {
    return Promise.reject(unavailable('permanent session deletion'))
  }

  public async rename(sessionId: string, title: string, signal?: AbortSignal): Promise<string> {
    return acceptedRenameTitle(
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
    const dataUri = parseBase64DataUri(rawData)
    const mediaType = typeof reference.mediaType === 'string' ? reference.mediaType.toLowerCase() : undefined
    const encoded = dataUri?.encoded ?? rawData
    const resolvedMediaType = dataUri?.mediaType ?? mediaType
    // A read is bounded by what this client can carry, not by the current
    // `imageLimits` admission policy: DSH may still hold an image from an
    // earlier turn that the stricter limit would reject for sending.
    const decoded = decodeBase64Payload(encoded, this.maxPromptAttachmentBytes)
    if ('problem' in decoded && decoded.problem === 'too-large')
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'The historical attachment is too large to display.',
        retryable: false,
      })
    const bytes = 'bytes' in decoded ? decoded.bytes : undefined
    if (
      resolvedMediaType === undefined ||
      !isSupportedImageMimeType(resolvedMediaType) ||
      bytes === undefined ||
      !validAttachmentReference(reference, attachmentId)
    )
      throw new AppError({
        code: 'PROTOCOL_ERROR',
        message: 'DSH returned an invalid historical attachment.',
        retryable: false,
      })
    if (
      bytes.length === 0 ||
      bytes.length !== reference.bytes ||
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
    if (!archived && !this.supportsSessionRestore) throw unavailable('session restoration')
    const method = archived ? 'workspace.archiveSession' : 'workspace.unarchiveSession'
    if (this.workspaceRepository !== undefined) {
      if (archived) await this.workspaceRepository.archiveSession(sessionId, signal)
      else await this.workspaceRepository.unarchiveSession(sessionId, signal)
      return
    }
    const value = recordOrUndefined(await callRpc<unknown>(this.transport, method, { sessionId }, signal))
    if (value === undefined || !isNonEmptyStringArray(value.archivedSessionIds))
      throw malformedSessionResponse('session archive receipt')
  }

  public sendPrompt(
    input: PromptInput,
    mode: RunningInputMode = 'queue',
    signal?: AbortSignal,
  ): Promise<void> {
    return this.promptQueue.sendPrompt(input, mode, signal)
  }

  public enqueuePrompt(
    input: PromptInput,
    mode: RunningInputMode,
    signal?: AbortSignal,
  ): Promise<QueuedInput> {
    return this.promptQueue.enqueuePrompt(input, mode, signal)
  }

  public listQueue(sessionId: string, signal?: AbortSignal): Promise<readonly QueuedInput[]> {
    return this.promptQueue.listQueue(sessionId, signal)
  }

  public sessionForQueuedInput(inputId: string): string | undefined {
    return this.promptQueue.sessionForQueuedInput(inputId)
  }

  public updateQueuedInput(inputId: string, text: string, signal?: AbortSignal): Promise<void> {
    return this.promptQueue.updateQueuedInput(inputId, text, signal)
  }

  public removeQueuedInput(inputId: string, signal?: AbortSignal): Promise<void> {
    return this.promptQueue.removeQueuedInput(inputId, signal)
  }

  public convertQueuedInputToSteer(inputId: string, signal?: AbortSignal): Promise<void> {
    return this.promptQueue.convertQueuedInputToSteer(inputId, signal)
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
    return setSessionConfiguration(
      {
        transport: this.transport,
        commandAttachmentWire: this.commandAttachmentWire,
        readPermissionPresets: this.readPermissionPresets,
        selectAgentPreset: this.selectAgentPreset,
        executeSessionConfigurationCommand: this.executeSessionConfigurationCommand,
        get: (id, operationSignal) => this.get(id, operationSignal),
      },
      sessionId,
      configuration,
      signal,
    )
  }

  private promptContentLimits(sessionId: string): PromptContentLimits {
    const imageLimits = this.imageLimitsBySession.get(sessionId)
    return {
      allowBinaryFiles: this.supportsFileUploads,
      maxImageBytes:
        imageLimits === undefined
          ? this.maxPromptAttachmentBytes
          : Math.min(this.maxPromptAttachmentBytes, imageLimits.maxImageBytes),
      maxAttachmentTotalBytes: this.maxPromptAttachmentTotalBytes,
      maxImageTotalBytes:
        imageLimits === undefined
          ? this.maxPromptAttachmentTotalBytes
          : Math.min(this.maxPromptAttachmentTotalBytes, imageLimits.maxMessageImageBytes),
      ...(imageLimits === undefined ? {} : { maxImagesPerMessage: imageLimits.maxImagesPerMessage }),
      ...(imageLimits === undefined ? {} : { mediaTypes: new Set(imageLimits.mediaTypes) }),
    }
  }

  private rememberProjectionValues(
    sessionId: string,
    values: Readonly<Record<string, unknown>> | undefined,
    authoritative = false,
  ): void {
    if (values === undefined) return
    if (Object.prototype.hasOwnProperty.call(values, 'imageLimits')) {
      this.rememberImageLimitsValue(sessionId, values.imageLimits)
    } else if (authoritative) {
      this.imageLimitsBySession.delete(sessionId)
    }
  }

  private rememberImageLimitsValue(sessionId: string, value: unknown): void {
    const limits = parseImageAttachmentLimits(value)
    // A malformed advisory projection must not erase a previously valid limit and
    // make prompt admission fall back to the less restrictive local defaults.
    if (limits !== undefined) this.imageLimitsBySession.set(sessionId, limits)
  }
}

export { historyGapRecovery } from './session/history-recovery.js'
export type { Rc6SessionRepositoryOptions } from './session/options.js'
