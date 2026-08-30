import { createHash } from 'node:crypto'

import {
  AppError,
  CHANGE_LIMITS,
  changeDiffBytes,
  changeEvidenceRank,
  changeLineDelta,
  isCanonicalWorkspaceRelativePath,
  isChangeDiff,
  type BackendEvent,
  type ChangeDetail,
  type ChangeListQuery,
  type ChangeObservation,
  type ChangeReviewState,
  type ChangeSetFile,
  type ConnectedBackend,
  type DshBackend,
  type FeatureEventIdentity,
  type ToolCallView,
  type ToolLocationView,
} from '@dsh-vscode/domain'

const HASH_PATTERN = /^[a-f0-9]{64}$/u

export interface ChangeSetTrackerOptions {
  readonly now?: () => number
  /** Host-only hash observation; no bytes cross this callback boundary. */
  readonly readObservedHash?: (workspaceFolderId: string, relativePath: string) => Promise<string | undefined>
  /** Resolve the authoritative workspace for a session before accepting events. */
  readonly resolveSessionWorkspaceFolderId?: (
    backend: DshBackend,
    sessionId: string,
  ) => Promise<string | undefined>
  readonly onChange?: (change: ChangeSetFile) => void
}

/**
 * Host-owned change projection. It consumes only structured tool presentation
 * and explicit mutation metadata; ordinary assistant text and generic tool
 * output never create a change row.
 */
export class ChangeSetTracker {
  private readonly entries = new Map<string, ChangeSetFile>()
  private readonly seenEvents = new Set<string>()
  private readonly sessionWorkspaceResolutions = new Map<string, Promise<string | undefined>>()
  private readonly now: () => number
  private readonly readObservedHash: ChangeSetTrackerOptions['readObservedHash']
  private readonly resolveSessionWorkspaceFolderId: ChangeSetTrackerOptions['resolveSessionWorkspaceFolderId']
  private readonly onChange: ChangeSetTrackerOptions['onChange']
  private unsubscribe: (() => void) | undefined
  private backend: ConnectedBackend | undefined
  private workspaceFolderId: (() => string | undefined) | undefined
  private localSequence = 0
  private attachmentGeneration = 0

  public constructor(options: ChangeSetTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.readObservedHash = options.readObservedHash
    this.resolveSessionWorkspaceFolderId = options.resolveSessionWorkspaceFolderId
    this.onChange = options.onChange
  }

  public attach(backend: DshBackend, workspaceFolderId: () => string | undefined): void {
    this.detach()
    this.entries.clear()
    this.seenEvents.clear()
    this.sessionWorkspaceResolutions.clear()
    this.localSequence = 0
    this.backend = backend.connection
    this.workspaceFolderId = workspaceFolderId
    const attachmentGeneration = ++this.attachmentGeneration
    const connection = backend.connection
    this.unsubscribe = backend.events.subscribe((event) => {
      void this.observeBackendEvent(event, attachmentGeneration, connection, backend).catch(() => undefined)
    })
  }

  public detach(): void {
    this.attachmentGeneration += 1
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.backend = undefined
    this.workspaceFolderId = undefined
    this.entries.clear()
    this.seenEvents.clear()
    this.sessionWorkspaceResolutions.clear()
    this.localSequence = 0
  }

  public dispose(): void {
    this.detach()
    this.entries.clear()
    this.seenEvents.clear()
  }

  public observe(observation: ChangeObservation): void {
    void this.observeNow(observation)
  }

  /** Exposed for deterministic contract tests and controlled Host callers. */
  public async observeNow(observation: ChangeObservation): Promise<void> {
    await this.observeNowIfActive(observation, () => true)
  }

  private async observeNowIfActive(observation: ChangeObservation, isActive: () => boolean): Promise<void> {
    if (!isActive()) return
    if (observation.tool.id.trim() === '') return
    const eventKey = observationEventKey(observation)
    if (this.seenEvents.has(eventKey)) return
    this.seenEvents.add(eventKey)
    while (this.seenEvents.size > CHANGE_LIMITS.maxFiles * 8)
      this.seenEvents.delete(this.seenEvents.values().next().value as string)

    const candidates = changeCandidates(observation.tool)
    if (candidates.length === 0) return
    for (const candidate of candidates) {
      if (!isActive()) return
      if (!isCanonicalWorkspaceRelativePath(candidate.relativePath)) continue
      const changeId = stableChangeId(observation, candidate.relativePath)
      const incoming = this.toChange(observation, candidate, changeId)
      const current = this.entries.get(changeId)
      const next = current === undefined ? incoming : mergeChange(current, incoming)
      if (!isActive()) return
      this.entries.set(changeId, next)
      this.onChange?.(next)
      if (
        incoming.evidence === 'structuredToolSuccess' &&
        incoming.proposalNewHash !== undefined &&
        this.readObservedHash !== undefined
      )
        await this.observeAppliedHash(changeId, incoming, isActive)
    }
    if (!isActive()) return
    this.trim()
  }

  public list(query: ChangeListQuery = {}, signal?: AbortSignal): Promise<readonly ChangeSetFile[]> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal)
      const offset = parseCursor(query.cursor)
      const limit = Math.min(Math.max(query.limit ?? CHANGE_LIMITS.maxFiles, 1), CHANGE_LIMITS.maxFiles)
      const filtered = [...this.entries.values()]
        .filter(
          (change) =>
            (query.workspaceFolderId === undefined || change.workspaceFolderId === query.workspaceFolderId) &&
            (query.sessionId === undefined || change.sessionId === query.sessionId) &&
            (query.status === undefined || change.status === query.status),
        )
        .sort(
          (left, right) => right.lastSeenAt - left.lastSeenAt || left.changeId.localeCompare(right.changeId),
        )
      return filtered.slice(offset, offset + limit)
    })
  }

  public get(changeId: string, signal?: AbortSignal): Promise<ChangeDetail> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal)
      const change = this.entries.get(changeId)
      if (change === undefined) throw changeUnavailable()
      const diffText = change.diff === undefined ? undefined : formatDiff(change.diff)
      const diffTruncated = diffText !== undefined && byteLength(diffText) > CHANGE_LIMITS.maxDiffBytes
      return {
        ...change,
        ...(diffText === undefined
          ? {}
          : { redactedDiff: diffTruncated ? truncateUtf8(diffText, CHANGE_LIMITS.maxDiffBytes) : diffText }),
        diffTruncated,
      }
    })
  }

  public markReviewed(
    changeId: string,
    reviewState: ChangeReviewState,
    signal?: AbortSignal,
  ): Promise<ChangeSetFile> {
    return Promise.resolve().then(() => {
      throwIfAborted(signal)
      const current = this.entries.get(changeId)
      if (current === undefined) throw changeUnavailable()
      const next = { ...current, reviewState }
      this.entries.set(changeId, next)
      this.onChange?.(next)
      return next
    })
  }

  public get size(): number {
    return this.entries.size
  }

  private async observeBackendEvent(
    event: BackendEvent,
    attachmentGeneration: number,
    connection: ConnectedBackend,
    backend: DshBackend,
  ): Promise<void> {
    if (event.type !== 'tool.updated') return
    const isActive = (): boolean =>
      this.attachmentGeneration === attachmentGeneration && this.backend === connection
    if (!isActive()) return
    const currentWorkspaceFolderId = this.workspaceFolderId?.()
    if (currentWorkspaceFolderId === undefined) return
    const eventWorkspaceFolderId =
      this.resolveSessionWorkspaceFolderId === undefined
        ? currentWorkspaceFolderId
        : await this.resolveSessionWorkspace(backend, event.sessionId)
    if (
      !isActive() ||
      eventWorkspaceFolderId === undefined ||
      eventWorkspaceFolderId !== currentWorkspaceFolderId
    )
      return
    const identity = this.identity(event, connection)
    await this.observeNowIfActive(
      {
        sessionId: event.sessionId,
        workspaceFolderId: eventWorkspaceFolderId,
        identity,
        tool: event.tool,
        observedAt: this.now(),
      },
      isActive,
    )
  }

  /**
   * The session-to-workspace mapping is stable for one backend attachment,
   * and every tool event needs it before the seen-events dedupe. Cache the
   * resolution per attachment (cleared in attach/detach) so an active turn's
   * tool stream costs one lookup per session instead of a full
   * session.list + session.history round trip per event. Unsettled outcomes
   * (unattributable session, transient failure) are retried on the next event.
   */
  private resolveSessionWorkspace(backend: DshBackend, sessionId: string): Promise<string | undefined> {
    const cached = this.sessionWorkspaceResolutions.get(sessionId)
    if (cached !== undefined) return cached
    const resolution = this.resolveSessionWorkspaceFolderId?.(backend, sessionId).then(
      (value) => {
        if (value === undefined) this.sessionWorkspaceResolutions.delete(sessionId)
        return value
      },
      () => {
        this.sessionWorkspaceResolutions.delete(sessionId)
        return undefined
      },
    )
    if (resolution === undefined) return Promise.resolve(undefined)
    this.sessionWorkspaceResolutions.set(sessionId, resolution)
    return resolution
  }

  private identity(
    event: Extract<BackendEvent, { readonly type: 'tool.updated' }>,
    backend: ConnectedBackend,
  ): FeatureEventIdentity {
    if (
      backend === undefined ||
      backend.backendInstanceId === undefined ||
      backend.connectionGeneration === undefined
    )
      throw new AppError({
        code: 'GENERATION_MISMATCH',
        message: 'The DSH connection identity is not ready for change tracking.',
        retryable: true,
      })
    const common = {
      backendInstanceId: backend.backendInstanceId,
      connectionGeneration: backend.connectionGeneration,
      toolCallId: event.tool.id,
    }
    if (event.sequence !== undefined && Number.isSafeInteger(event.sequence) && event.sequence >= 0)
      return { ...common, stream: 'mux', sessionId: event.sessionId, serverSeq: event.sequence }
    return { ...common, stream: 'host', sessionId: event.sessionId, localSeq: ++this.localSequence }
  }

  private toChange(
    observation: ChangeObservation,
    candidate: ChangeCandidate,
    changeId: string,
  ): ChangeSetFile {
    const tool = observation.tool
    const diff = candidate.diff
    const failed = tool.status === 'failed' || tool.status === 'cancelled'
    const successful = tool.status === 'completed' && tool.presentation?.phase === 'result'
    const evidence = failed
      ? 'failed'
      : diff !== undefined
        ? successful
          ? 'structuredToolSuccess'
          : 'structuredProposal'
        : candidate.locations.length > 0
          ? 'structuredLocationOnly'
          : 'incomplete'
    const delta = diff === undefined ? undefined : changeLineDelta(diff)
    const metadata = tool.metadata
    const proposalOldHash = hashMetadata(metadata, ['proposalOldHash', 'oldHash'])
    const proposalNewHash = hashMetadata(metadata, ['proposalNewHash', 'newHash'])
    const previousRelativePath = canonicalMetadataPath(metadata, ['previousRelativePath', 'renameFrom'])
    const status = previousRelativePath === undefined ? candidate.status : 'renamed'
    const firstSeenAt = parseTime(tool.startedAt) ?? observation.observedAt
    const lastSeenAt = parseTime(tool.completedAt) ?? observation.observedAt
    const sourceInteractionIds = stringMetadata(metadata, ['interactionId', 'rpcId'])
    return {
      changeId,
      sessionId: observation.sessionId,
      workspaceFolderId: observation.workspaceFolderId,
      relativePath: candidate.relativePath,
      ...(previousRelativePath === undefined ? {} : { previousRelativePath }),
      status,
      ...(delta === undefined ? {} : { additions: delta.additions, deletions: delta.deletions }),
      ...(proposalOldHash === undefined ? {} : { proposalOldHash }),
      ...(proposalNewHash === undefined ? {} : { proposalNewHash }),
      ...(diff === undefined ? {} : { diff }),
      locations: candidate.locations,
      evidence,
      applicationState: failed ? 'failed' : diff === undefined ? 'unknown' : 'proposed',
      reviewState: 'unreviewed',
      sourceIds: [tool.id],
      sourceInteractionIds,
      sourceToolCallIds: [tool.id],
      firstSeenAt,
      lastSeenAt: Math.max(firstSeenAt, lastSeenAt),
      identity: observation.identity,
      diffAvailable: diff !== undefined,
    }
  }

  private async observeAppliedHash(
    changeId: string,
    incoming: ChangeSetFile,
    isActive: () => boolean,
  ): Promise<void> {
    const readObservedHash = this.readObservedHash
    if (readObservedHash === undefined || incoming.proposalNewHash === undefined) return
    const observedHash = await readObservedHash(incoming.workspaceFolderId, incoming.relativePath).catch(
      () => undefined,
    )
    if (observedHash === undefined || !HASH_PATTERN.test(observedHash)) return
    if (!isActive()) return
    const current = this.entries.get(changeId)
    if (current === undefined || current.proposalNewHash !== incoming.proposalNewHash) return
    if (observedHash !== incoming.proposalNewHash) return
    if (!isActive()) return
    this.entries.set(changeId, {
      ...current,
      evidence: 'structuredToolSuccess',
      applicationState: 'appliedObserved',
      observedHash,
    })
    this.onChange?.(this.entries.get(changeId)!)
  }

  private trim(): void {
    let totalBytes = 0
    const entries = [...this.entries.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    for (const entry of entries) {
      totalBytes += entry.diff === undefined ? 0 : changeDiffBytes(entry.diff)
      if (entries.indexOf(entry) >= CHANGE_LIMITS.maxFiles || totalBytes > CHANGE_LIMITS.maxTotalBytes)
        this.entries.delete(entry.changeId)
    }
  }
}

interface ChangeCandidate {
  readonly relativePath: string
  readonly status: ChangeSetFile['status']
  readonly diff?: ChangeSetFile['diff']
  readonly locations: readonly ToolLocationView[]
}

function changeCandidates(tool: ToolCallView): readonly ChangeCandidate[] {
  const presentation = tool.presentation
  const diffEntries =
    presentation?.card === 'diff' && 'diffs' in presentation
      ? presentation.diffs.filter(isChangeDiff).slice(0, CHANGE_LIMITS.maxSources * 2)
      : []
  const locations = safeLocations(
    tool.locations ??
      (presentation !== undefined && 'locations' in presentation ? presentation.locations : undefined),
  )
  const byPath = new Map<string, ChangeCandidate>()
  for (const diff of diffEntries) {
    const path = diff.path
    if (!isCanonicalWorkspaceRelativePath(path)) continue
    const diffValue = { oldText: diff.oldText, newText: diff.newText }
    byPath.set(path, {
      relativePath: path,
      status: changeStatus(diffValue),
      diff: diffValue,
      locations: locationsForPath(locations, path),
    })
  }
  const mutation = isMutationTool(tool)
  if (mutation) {
    for (const location of locations) {
      if (byPath.has(location.path)) continue
      byPath.set(location.path, {
        relativePath: location.path,
        status: 'unknown',
        locations: [location],
      })
    }
  }
  return [...byPath.values()].slice(0, CHANGE_LIMITS.maxFiles)
}

function isMutationTool(tool: ToolCallView): boolean {
  const metadata = tool.metadata
  return (
    tool.category === 'diff' ||
    tool.category === 'edit' ||
    metadata.card === 'diff' ||
    metadata.kind === 'edit' ||
    metadata.mutation === true
  )
}

function safeLocations(value: readonly ToolLocationView[] | undefined): readonly ToolLocationView[] {
  if (value === undefined) return []
  const locations: ToolLocationView[] = []
  for (const location of value) {
    if (!isCanonicalWorkspaceRelativePath(location.path)) continue
    if (
      location.line !== undefined &&
      (!Number.isSafeInteger(location.line) || location.line < 0 || location.line > 1_000_000)
    )
      continue
    locations.push(location)
    if (locations.length >= 32) break
  }
  return locations
}

function locationsForPath(
  locations: readonly ToolLocationView[],
  relativePath: string,
): readonly ToolLocationView[] {
  const matching = locations.filter((location) => location.path === relativePath)
  return matching.length === 0 ? [{ path: relativePath }] : matching
}

function changeStatus(diff: {
  readonly oldText: string | null
  readonly newText: string
}): ChangeSetFile['status'] {
  if (diff.oldText === null) return 'added'
  if (diff.newText.length === 0 && diff.oldText.length > 0) return 'deleted'
  return 'modified'
}

function mergeChange(current: ChangeSetFile, incoming: ChangeSetFile): ChangeSetFile {
  const currentRank = changeEvidenceRank(current.evidence)
  const incomingRank = changeEvidenceRank(incoming.evidence)
  const keepCurrent = incomingRank < currentRank
  const sourceIds = uniqueBounded([...current.sourceIds, ...incoming.sourceIds], 16)
  const sourceInteractionIds = uniqueBounded(
    [...current.sourceInteractionIds, ...incoming.sourceInteractionIds],
    16,
  )
  const sourceToolCallIds = uniqueBounded([...current.sourceToolCallIds, ...incoming.sourceToolCallIds], 16)
  const locations = uniqueLocations([...current.locations, ...incoming.locations])
  const preferred = keepCurrent ? current : incoming
  return {
    ...preferred,
    sourceIds,
    sourceInteractionIds,
    sourceToolCallIds,
    locations,
    firstSeenAt: Math.min(current.firstSeenAt, incoming.firstSeenAt),
    lastSeenAt: Math.max(current.lastSeenAt, incoming.lastSeenAt),
    reviewState: current.reviewState,
    ...(preferred.diff === undefined && current.diff !== undefined
      ? { diff: current.diff, diffAvailable: true }
      : {}),
    ...(preferred.proposalOldHash === undefined && current.proposalOldHash === undefined
      ? {}
      : { proposalOldHash: preferred.proposalOldHash ?? current.proposalOldHash }),
    ...(preferred.proposalNewHash === undefined && current.proposalNewHash === undefined
      ? {}
      : { proposalNewHash: preferred.proposalNewHash ?? current.proposalNewHash }),
  }
}

function uniqueLocations(locations: readonly ToolLocationView[]): readonly ToolLocationView[] {
  const seen = new Set<string>()
  const result: ToolLocationView[] = []
  for (const location of locations) {
    const key = `${location.path}:${location.line ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(location)
    if (result.length >= 32) break
  }
  return result
}

function uniqueBounded(values: readonly string[], limit: number): readonly string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))].slice(0, limit)
}

function stableChangeId(observation: ChangeObservation, relativePath: string): string {
  return createHash('sha256')
    .update(
      `${observation.identity.backendInstanceId}:${observation.identity.connectionGeneration}:${observation.sessionId}:${observation.tool.id}:${relativePath}`,
    )
    .digest('hex')
    .slice(0, 40)
}

function observationEventKey(observation: ChangeObservation): string {
  const identity = observation.identity
  const sequence = identity.stream === 'mux' ? identity.serverSeq : identity.localSeq
  return `${identity.backendInstanceId}:${identity.connectionGeneration}:${identity.stream}:${identity.sessionId ?? ''}:${sequence}:${identity.eventId ?? ''}:${identity.rpcId ?? ''}:${identity.toolCallId ?? observation.tool.id}:${observation.tool.status}:${observation.tool.presentation?.phase ?? ''}`
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function hashMetadata(
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && HASH_PATTERN.test(value)) return value
  }
  return undefined
}

function canonicalMetadataPath(
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === 'string' && isCanonicalWorkspaceRelativePath(value)) return value
  }
  return undefined
}

function stringMetadata(
  metadata: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): readonly string[] {
  return uniqueBounded(
    keys.flatMap((key) => {
      const value = metadata[key]
      return typeof value === 'string' && value.length <= 256 ? [value] : []
    }),
    16,
  )
}

function formatDiff(diff: NonNullable<ChangeSetFile['diff']>): string {
  return [`--- old`, diff.oldText ?? '', `+++ new`, diff.newText].join('\n')
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  let result = ''
  for (const character of value) {
    if (byteLength(result + character) > maxBytes) break
    result += character
  }
  return result
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0
  const parsed = Number(cursor)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The change request was cancelled.',
      retryable: true,
    })
}

function changeUnavailable(): AppError {
  return new AppError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'The requested structured change is no longer available.',
    retryable: false,
  })
}
