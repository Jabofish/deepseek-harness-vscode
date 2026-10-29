import { sameTimelineValue } from '@dsh-vscode/timeline'
import { TranscriptEventBuffer, isTextEvent } from './transcript-event-buffer.js'
import { createHash } from 'node:crypto'
import { TranscriptContentVersions } from './transcript-content-version.js'
import {
  AppError,
  type BackendEvent,
  type SessionDetail,
  type SessionHistoryPage,
  type TodoView,
} from '@dsh-vscode/domain'
import {
  reduceTimeline,
  appendedTextNodeChars,
  isRedundantTurnFailureNotice,
  timelineSequenceOptions,
  type TimelineNode,
  type TimelineState,
} from '@dsh-vscode/timeline'
import {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MAX_NODES,
  TRANSCRIPT_NODE_CHARS,
  transcriptNodeSchema,
  transcriptPatchSchema,
  transcriptWindowSchema,
  type TranscriptPatch,
  type TranscriptTextUpdate,
  type TranscriptWindow,
  type TranscriptEventFact,
} from '@dsh-vscode/webview-protocol'

type ReadPage = (
  sessionId: string,
  before: number | undefined,
  signal: AbortSignal,
  child: boolean,
) => Promise<SessionHistoryPage>
// Ordinary conversation bodies travel intact. The bounded transport window is
// independent of full content, which visible rows obtain automatically.
const MESSAGE_NODE_CHARS = TRANSCRIPT_MAX_CHARS - 192 * 1024
/** Bound immediate recovery attempts when a window cannot enter the renderer. */
const DELIVERY_RETRY_LIMIT = 3
/** A transiently unavailable visible renderer may also miss the invalidation. */
const DELIVERY_RECOVERY_DELAYS = [250, 1_000, 3_000] as const
const DELIVERY_RECOVERY_MAX_DELAY = 10_000
interface PendingOpen {
  readonly sessionId: string
  readonly generation: number
  readonly child: boolean
  events: TranscriptEventBuffer
  chars: number
  overflow: boolean
  cwd?: string
  cwdSequence?: number
  cwdKnown?: boolean
}
interface Resident {
  expanded?: boolean
  readonly sessionId: string
  readonly child: boolean
  readonly baselineSequence: number
  timeline: TimelineState
  liveBodies: Map<string, TimelineNode>
  hasMore: boolean
  before?: number
  upper?: number
  omitted: Set<string>
  sources: Map<string, { from: number; to: number }>
  /** Raw sizes follow immutable node identities and are pruned on eviction. */
  rawChars: Map<string, { readonly node: TimelineNode; readonly chars: number }>
  facts: TranscriptEventFact[]
  factCounter: number
  contextIds: Set<string>
  cwd?: string
  cwdSequence?: number
  currentTodos?: readonly TodoView[]
  currentTodosOmitted?: true
  nativeTodos: boolean
  boundDirty?: boolean
}
interface WindowMetadataSource {
  readonly facts: number
  readonly lastSequence: number
  readonly activeTurn: number | undefined
  readonly tokenUsage: TranscriptWindow['tokenUsage']
  readonly hasMore: boolean
  readonly before: number | undefined
  readonly historical: boolean
  readonly omitted: string
  readonly contentVersions: string
  readonly todos: readonly TodoView[] | undefined
  readonly todosOmitted: true | undefined
}

/** A presentation cache. DSH owns durable ordering, recovery and domain projections. */
export class TranscriptWindowService {
  private readonly contentVersions = new TranscriptContentVersions()
  private generation = 0
  private revision = 0
  private pending: PendingOpen | undefined
  private tail: Resident | undefined
  private displayed: Resident | undefined
  private readonly forward: (number | undefined)[] = []
  private readonly sameSequence = new Set<string>()
  private identitySequence = -1
  private visible = true
  private readonly ingress = new TranscriptEventBuffer()
  private needsRebase = false
  private overloadBudget = { started: 0, count: 0 }
  private dirty = false
  private posting = false
  private readonly pendingAcks = new Map<number, number>()
  private pendingChars = 0
  private budgetBlocked = false
  private published:
    | {
        readonly sessionId: string
        readonly revision: number
        readonly cwd: string | undefined
        readonly nodes: ReadonlyMap<string, TimelineNode>
        readonly publicNodes: ReadonlyMap<string, TimelineNode>
        readonly metadataSource: WindowMetadataSource
      }
    | undefined
  private invalidated = false
  private retryAttempt = 0
  private recoveryAttempt = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private deliverySuspended = false
  private deliveryEpoch = 0
  private readonly recentEvents = new Map<string, true>()
  private hostSequence = 0
  private readonly notices = new Map<
    string,
    { node: TimelineNode; anchors: readonly string[]; chars: number; range?: { from: number; to: number } }[]
  >()
  private readonly previews = new WeakMap<
    TimelineNode,
    {
      value: TimelineNode
      omitted: boolean
      size: number
      rawSize: number
      contentOmitted: boolean
      publicCwd: string | undefined
    }
  >()

  public constructor(
    private readonly deps: {
      readonly read: ReadPage
      readonly publicValue: (value: unknown, cwd?: string) => unknown
      readonly post: (window: TranscriptWindow) => Promise<boolean>
      readonly postPatch?: (patch: TranscriptPatch) => Promise<boolean>
      readonly invalidate?: (sessionId: string) => void
      readonly consumerDriven?: boolean
      readonly refresh?: (sessionId: string) => Promise<void>
      readonly onCapacity?: (ready: boolean) => void
      readonly report?: (failure: { readonly attempt: number; readonly retrying: boolean }) => void
    },
  ) {}

  public begin(sessionId: string, child = false, recovery = false): number {
    this.cancelRecovery()
    if (this.activeSessionId() !== sessionId || !recovery) {
      this.clearRetry()
    }
    this.deliverySuspended = false
    if (!recovery) this.overloadBudget = { started: performance.now(), count: 0 }
    const generation = ++this.generation
    this.deliveryEpoch++
    // Reads and invalidations are not proof that the renderer recovered.
    this.published = undefined
    this.ingress.clear()
    this.needsRebase = false
    this.pending = {
      sessionId,
      generation,
      child,
      events: new TranscriptEventBuffer(),
      chars: 0,
      overflow: false,
    }
    return generation
  }

  public needsRefresh(generation: number): boolean {
    return this.pending?.generation === generation && this.pending.overflow
  }

  public restart(generation: number): void {
    const pending = this.pending
    if (pending?.generation !== generation) return
    pending.events.clear()
    pending.chars = 0
    pending.overflow = false
  }

  public install(detail: SessionDetail, generation: number): TranscriptWindow {
    return this.installPage(
      detail.id,
      {
        events: detail.history ?? [],
        hasMore: detail.historyHasMore ?? false,
        ...(detail.historyBeforeSequence === undefined
          ? {}
          : { beforeSequence: detail.historyBeforeSequence }),
      },
      generation,
      detail.cwd,
    )
  }

  public installPage(
    sessionId: string,
    page: SessionHistoryPage,
    generation: number,
    cwd?: string,
  ): TranscriptWindow {
    if (this.pending?.generation !== generation || this.pending.sessionId !== sessionId) throw stale()
    if (this.pending.overflow) throw stale()
    const previousResident =
      this.tail?.sessionId === sessionId
        ? this.tail
        : this.displayed?.sessionId === sessionId
          ? this.displayed
          : undefined
    const resident = this.project(sessionId, page, this.pending.child, undefined, cwd)
    if (
      this.pending.cwdKnown &&
      (this.pending.cwdSequence === undefined ||
        this.pending.cwdSequence > (page.projection?.asOfSequence ?? -1))
    ) {
      if (this.pending.cwd === undefined) delete resident.cwd
      else resident.cwd = this.pending.cwd
    }
    const pending = this.pending.events.take()
    this.pending = undefined
    this.tail = resident
    this.displayed = resident
    this.forward.length = 0
    this.invalidated = false
    this.deliverySuspended = false
    this.recentEvents.clear()
    for (const entry of page.events) this.rememberIdentity(entry.event, entry.sequence)
    this.sameSequence.clear()
    this.identitySequence = -1
    this.identitySequence = resident.timeline.lastSequence
    for (const entry of page.events)
      if (entry.sequence === this.identitySequence)
        this.sameSequence.add(eventIdentity(entry.event, entry.sequence))
    const settlements = new Map<string, number>()
    for (const entry of page.events) {
      const event = entry.event
      if (event.type === 'message.completed' || event.type === 'assistant.attempt')
        settlements.set(assistantKey(event), entry.sequence)
    }
    for (const event of pending) {
      if (
        (event.type === 'message.delta' || event.type === 'reasoning.delta') &&
        event.transientStartedAfterSequence !== undefined &&
        (settlements.get(assistantKey(event)) ?? -1) > event.transientStartedAfterSequence
      )
        continue
      this.reduce(resident, event)
    }
    this.ensureProjected(resident)
    if (previousResident !== undefined) this.reconcileResidentNodes(resident, previousResident)
    this.revision++
    this.published = undefined
    this.pendingAcks.clear()
    this.pendingChars = 0
    this.budgetBlocked = false
    this.deps.onCapacity?.(this.previewCanResume())
    return this.snapshot()
  }

  public cancel(generation: number): void {
    if (this.pending?.generation === generation) this.pending = undefined
  }

  /** Content is never queued for the renderer; only the latest bounded window is published. */
  public accept(event: BackendEvent): boolean {
    const sessionId = ('sessionId' in event ? event.sessionId : undefined) ?? this.tail?.sessionId
    if (event.type === 'session.subscribed' && this.tail !== undefined && this.tail.sessionId === sessionId) {
      this.tail.timeline = reduceTimeline(this.tail.timeline, {
        event,
        sequence: this.tail.timeline.lastSequence,
        advanceSequence: false,
      })
      if (this.displayed === this.tail) {
        this.revision++
        this.schedule()
      }
    }
    if (event.type === 'session.projection' && event.key === 'workingDirectory') {
      for (const target of [this.pending, this.tail])
        if (
          target !== undefined &&
          target.sessionId === sessionId &&
          (event.sequence === undefined ||
            target.cwdSequence === undefined ||
            event.sequence >= target.cwdSequence)
        ) {
          if (typeof event.value === 'string') target.cwd = event.value
          else delete target.cwd
          if (event.sequence !== undefined) target.cwdSequence = event.sequence
          if ('overflow' in target) target.cwdKnown = true
        }
    }
    if (
      event.type === 'session.projection' &&
      event.key === 'todoList' &&
      this.tail !== undefined &&
      this.tail.sessionId === sessionId
    ) {
      this.tail.nativeTodos = true
      delete this.tail.currentTodos
      delete this.tail.currentTodosOmitted
    }
    if (!isTranscriptEvent(event)) {
      const controlSession =
        event.type === 'permission.requested'
          ? event.request.sessionId
          : event.type === 'question.requested'
            ? event.question.sessionId
            : sessionId
      const interaction = event.type === 'permission.requested' || event.type === 'question.requested'
      if ((this.visible || interaction) && controlSession === this.tail?.sessionId)
        this.flushIngress(interaction)
      return false
    }
    const pending = this.pending
    if (pending !== undefined && pending.sessionId === sessionId && !pending.overflow) {
      if (!pending.events.push(event)) pending.overflow = true
    }
    if (this.tail !== undefined && this.tail.sessionId === sessionId) {
      if (this.needsRebase) {
        this.invalidateIngress()
        return isTranscriptOnlyEvent(event)
      }
      if (
        !this.visible ||
        (this.deps.consumerDriven === true &&
          isTextEvent(event) &&
          (this.pendingAcks.size > 0 || this.posting || this.budgetBlocked))
      ) {
        if (!this.ingress.push(event)) {
          this.needsRebase = true
          this.noteOverload()
          this.deps.onCapacity?.(false)
          this.invalidateIngress()
        }
      } else {
        this.flushIngress()
        this.applyTailEvent(event)
      }
    } else if (isRetainedHostNotice(event) && sessionId !== undefined) {
      const scratch = reduceTimeline(empty(sessionId), {
        event,
        sequence: -++this.hostSequence,
        advanceSequence: false,
      })
      this.rememberNotices(
        sessionId,
        scratch.nodes,
        [],
        event.type === 'session.gap' ? { from: event.fromSequence, to: event.toSequence } : undefined,
      )
    }
    return isTranscriptOnlyEvent(event)
  }

  public async navigate(
    sessionId: string,
    direction: 'older' | 'newer' | 'latest',
    revision: number,
    signal: AbortSignal,
  ): Promise<TranscriptWindow> {
    this.flushIngress(false, false)
    if (
      this.tail?.sessionId !== sessionId ||
      this.displayed === undefined ||
      revision > this.revision ||
      (this.displayed !== this.tail && revision !== this.revision)
    )
      throw stale()
    this.ensureProjected(this.tail)
    this.ensureProjected(this.displayed)
    if (direction === 'latest') {
      if (this.invalidated) {
        const generation = this.begin(sessionId, this.tail.child)
        try {
          const page = await this.deps.read(sessionId, undefined, signal, this.tail.child)
          signal.throwIfAborted()
          return this.installPage(sessionId, page, generation)
        } finally {
          this.cancel(generation)
        }
      }
      this.displayed = this.tail
      this.forward.length = 0
      this.revision++
      this.published = undefined
      return this.snapshot()
    }
    signal.throwIfAborted()
    const generation = this.generation
    const previous = this.displayed
    if (direction === 'older' && (!previous.hasMore || previous.before === undefined)) return this.snapshot()
    if (direction === 'newer' && this.forward.length === 0) {
      this.displayed = this.tail
      this.revision++
      this.published = undefined
      return this.snapshot()
    }
    const before = direction === 'older' ? previous.before : this.forward[this.forward.length - 1]
    const page = await this.deps.read(sessionId, before, signal, previous.child)
    if (signal.aborted || generation !== this.generation || this.displayed !== previous) throw stale()
    if (direction === 'older') {
      if (
        page.beforeSequence !== undefined &&
        previous.before !== undefined &&
        page.beforeSequence >= previous.before
      )
        throw stale()
      const older = this.project(sessionId, page, previous.child, before, previous.cwd)
      const currentIds = new Set(previous.timeline.nodes.map((node) => node.id))
      const merged: Resident = {
        ...previous,
        expanded: true,
        timeline: {
          ...previous.timeline,
          nodes: [
            ...older.timeline.nodes.filter((node) => !currentIds.has(node.id)),
            ...previous.timeline.nodes,
          ],
          nodeChangeStart: 0,
        },
        hasMore: older.hasMore,
        sources: new Map([...older.sources, ...previous.sources]),
        rawChars: new Map([...older.rawChars, ...previous.rawChars]),
        omitted: new Set([...older.omitted, ...previous.omitted]),
        facts: [
          ...new Map([...older.facts, ...previous.facts].map((fact) => [fact.id, fact])).values(),
        ].slice(-256),
      }
      if (older.before === undefined) delete merged.before
      else merged.before = older.before
      this.bound(merged, true)
      // Keep receiving live changes in the expanded conversation. Only an
      // actual budget eviction needs the separate live-tail fallback.
      const keptIds = new Set(merged.timeline.nodes.map((node) => node.id))
      if (previous === this.tail && previous.timeline.nodes.every((node) => keptIds.has(node.id)))
        this.tail = merged
      this.displayed = merged
    } else {
      this.forward.pop()
      const nextDisplayed = this.project(sessionId, page, previous.child, before, previous.cwd)
      this.reconcileResidentNodes(nextDisplayed, previous)
      this.displayed = nextDisplayed
    }
    this.revision++
    this.published = undefined
    return this.snapshot()
  }

  /** Complete current content, including live bodies outside the transport window. */
  public fullNode(sessionId: string, nodeId: string, revision: number, signal: AbortSignal): TimelineNode {
    this.flushIngress(false, false)
    const displayed = this.displayed
    if (
      signal.aborted ||
      displayed?.sessionId !== sessionId ||
      revision > this.revision ||
      (displayed !== this.tail && revision !== this.revision)
    )
      throw stale()
    if (this.tail !== undefined) this.ensureProjected(this.tail)
    this.ensureProjected(displayed)
    const resident = this.tail?.sessionId === sessionId ? this.tail : displayed
    const displayedNode = displayed.timeline.nodes.find((candidate) => candidate.id === nodeId)
    // An approval can outlive its visible tool row (paging or a busy turn).
    // Its active canonical body remains readable without changing the viewport.
    const node = displayedNode ?? resident.liveBodies.get(nodeId)
    if (node === undefined) throw stale()
    const safe = this.deps.publicValue(node, displayedNode === undefined ? resident.cwd : displayed.cwd)
    const parsed = transcriptNodeSchema.safeParse(safe)
    if (parsed.success) return parsed.data as TimelineNode
    if (
      typeof safe === 'object' &&
      safe !== null &&
      'kind' in safe &&
      safe.kind === 'tool' &&
      'tool' in safe &&
      typeof safe.tool === 'object' &&
      safe.tool !== null
    ) {
      const { presentation, ...tool } = safe.tool as Record<string, unknown>
      // A required file path can be removed by the Host scope boundary. Keep
      // all remaining safe output on a generic card instead of discarding it.
      return transcriptNodeSchema.parse({
        ...safe,
        tool: {
          ...tool,
          ...(presentation === undefined
            ? {}
            : {
                presentation: { phase: 'result', card: 'generic', content: [JSON.stringify(presentation)] },
              }),
        },
      }) as TimelineNode
    }
    return transcriptNodeSchema.parse(safe) as TimelineNode
  }

  /** Copy and export share the complete canonical content used for display. */
  public async content(
    sessionId: string,
    nodeId: string,
    revision: number,
    signal: AbortSignal,
    includeReasoning = true,
  ): Promise<string> {
    await Promise.resolve()
    const safe = this.fullNode(sessionId, nodeId, revision, signal)
    return typeof safe === 'object' &&
      safe !== null &&
      'markdown' in safe &&
      typeof safe.markdown === 'string'
      ? includeReasoning &&
        'reasoning' in safe &&
        typeof safe.reasoning === 'object' &&
        safe.reasoning !== null &&
        'markdown' in safe.reasoning &&
        typeof safe.reasoning.markdown === 'string'
        ? `${safe.reasoning.markdown}\n\n${safe.markdown}`
        : safe.markdown
      : 'text' in safe && typeof safe.text === 'string'
        ? safe.text
        : JSON.stringify(safe, null, 2)
  }

  public setVisible(visible: boolean): void {
    const becameVisible = visible && !this.visible
    this.visible = visible
    if (!visible) this.cancelRecovery()
    if (becameVisible) {
      this.deliverySuspended = false
      this.clearRetry()
      this.invalidated = false
    }
    if (visible && this.needsRebase) {
      this.invalidateIngress()
      return
    }
    if (visible) this.flushIngress(false, false)
    if (visible && this.previewCanResume()) this.deps.onCapacity?.(true)
    if (visible && this.displayed !== undefined) {
      if (this.tail !== undefined) this.ensureProjected(this.tail)
      this.ensureProjected(this.displayed)
      this.deliveryEpoch++
      this.published = undefined
      this.revision++
      this.pendingAcks.clear()
      this.pendingChars = 0
      this.budgetBlocked = false
      this.schedule()
    }
  }

  public acknowledge(sessionId: string, revision: number): void {
    if (this.displayed?.sessionId !== sessionId || revision > this.revision) return
    if (this.overloadBudget.count > 0 && this.previewCanResume()) this.deps.onCapacity?.(true)
    for (const [sent, chars] of this.pendingAcks)
      if (sent <= revision) {
        this.pendingAcks.delete(sent)
        this.pendingChars -= chars
        this.budgetBlocked = false
      }
    if (this.visible && !this.needsRebase) this.flushIngress()
    if (this.dirty) this.schedule()
  }

  public showLatest(sessionId: string): void {
    if (this.tail?.sessionId !== sessionId) return
    this.ensureProjected(this.tail)
    this.displayed = this.tail
    this.forward.length = 0
    this.revision++
    this.published = undefined
    this.schedule()
  }

  public activeSessionId(): string | undefined {
    const current = this.pending ?? this.displayed ?? this.tail
    return current?.sessionId
  }

  public dispose(): void {
    ++this.generation
    this.ingress.clear()
    this.needsRebase = false
    this.pending = undefined
    this.tail = undefined
    this.displayed = undefined
    this.forward.length = 0
    this.sameSequence.clear()
    this.dirty = false
    this.pendingAcks.clear()
    this.pendingChars = 0
    this.budgetBlocked = false
    this.published = undefined
    this.invalidated = false
    this.deliverySuspended = false
    this.clearRetry()
    this.recentEvents.clear()
    this.notices.clear()
  }

  private project(
    sessionId: string,
    page: SessionHistoryPage,
    child: boolean,
    upper?: number,
    cwd?: string,
  ): Resident {
    const projectedCwd = page.projection?.values.workingDirectory
    const scopedCwd = typeof projectedCwd === 'string' ? projectedCwd : cwd
    const resident: Resident = {
      sessionId,
      child,
      baselineSequence: page.events.reduce(
        (latest, entry) => Math.max(latest, entry.sequence),
        page.projection?.asOfSequence ?? -1,
      ),
      timeline: empty(sessionId),
      hasMore: page.hasMore,
      omitted: new Set(),
      sources: new Map(),
      rawChars: new Map(),
      liveBodies: new Map(),
      facts: [],
      factCounter: 0,
      contextIds: new Set(),
      nativeTodos: Object.hasOwn(page.projection?.values ?? {}, 'todoList'),
      ...(scopedCwd === undefined ? {} : { cwd: scopedCwd }),
      ...(page.projection === undefined ? {} : { cwdSequence: page.projection.asOfSequence }),
      ...(page.beforeSequence === undefined ? {} : { before: page.beforeSequence }),
      ...(upper === undefined ? {} : { upper }),
    }
    if (resident.before === undefined && page.hasMore)
      for (const entry of page.events) {
        const position = entry.coveredSequences?.[0] ?? entry.sequence
        resident.before = resident.before === undefined ? position : Math.min(resident.before, position)
      }
    for (const entry of page.events) {
      this.rememberFact(resident, entry.event, entry.sequence, entry.coveredSequences?.length ?? 1)
      this.restoreLiveBody(resident, entry.event)
      const previous = resident.timeline.nodes
      resident.timeline = reduceTimeline(resident.timeline, {
        event: entry.event,
        sequence: entry.sequence,
        ...timelineSequenceOptions(entry.event),
        ...(entry.sequence === resident.timeline.lastSequence ? { advanceSequence: false as const } : {}),
      })
      this.rememberLiveBodies(resident, entry.event, previous)
      this.rememberChanges(resident, previous, entry.event, entry.sequence, entry.coveredSequences?.[0])
      this.bound(resident)
      this.updateCurrentTodos(resident, entry.event)
    }
    const restored = [...resident.timeline.nodes]
    let previousIndex = -1
    const notices = (this.notices.get(sessionId) ?? []).filter(
      (entry) =>
        entry.range === undefined ||
        !page.coveredSequenceRanges?.some(
          (range) => range.from <= entry.range!.from && range.to >= entry.range!.to,
        ),
    )
    if (this.notices.has(sessionId)) this.notices.set(sessionId, notices)
    for (const entry of notices) {
      if (
        restored.some((node) => node.id === entry.node.id) ||
        isRedundantTurnFailureNotice(entry.node, restored)
      )
        continue
      const anchor = entry.anchors
        .map((id) => restored.findIndex((node) => node.id === id))
        .find((index) => index >= 0)
      const index = Math.max(previousIndex + 1, anchor === undefined ? restored.length : anchor + 1)
      restored.splice(index, 0, entry.node)
      previousIndex = index
    }
    resident.timeline = { ...resident.timeline, nodes: restored }
    this.bound(resident)
    return resident
  }

  private reduce(resident: Resident, event: BackendEvent): void {
    const sequence = event.sequence ?? (event.type === 'notice' ? -++this.hostSequence : ++this.hostSequence)
    // History may compact or omit native rows. A follow replay below this read
    // cut is already represented; byte differences cannot prove a missed event.
    if (event.replayed === true && sequence <= resident.baselineSequence) return
    if (event.sequence !== undefined && timelineSequenceOptions(event).advanceSequence !== false) {
      if (sequence < resident.timeline.lastSequence) {
        // An Adapter recovery may fill an already-published view. Reread its
        // authoritative window; do not sort, backfill or replay another journal.
        const known = this.recentEvents.has(eventIdentity(event, sequence))
        if (!known && sequence >= (resident.before ?? 0) && this.pending === undefined) {
          this.needsRebase = true
          this.noteOverload()
          this.deps.onCapacity?.(false)
          // A lost-delivery notification must not hide a newly detected
          // history gap. Mark the rebase independently; deduplicate only its signal.
          if (!this.invalidated) {
            this.invalidated = true
            this.deps.invalidate?.(resident.sessionId)
          }
        }
        return
      }
      if (sequence !== this.identitySequence) {
        this.sameSequence.clear()
        this.identitySequence = sequence
      }
      const key = eventIdentity(event, sequence)
      if (this.sameSequence.has(key)) return
      if (this.sameSequence.size < 64) this.sameSequence.add(key)
      this.rememberIdentity(event, sequence)
    }
    if (
      resident.boundDirty === true &&
      event.type !== 'message.delta' &&
      event.type !== 'reasoning.delta' &&
      event.type !== 'tool.updated'
    ) {
      this.ensureProjected(resident)
    }
    this.restoreLiveBody(resident, event)
    const previous = resident.timeline.nodes
    if (event.sequence !== undefined) this.rememberFact(resident, event, event.sequence, 1)
    resident.timeline = reduceTimeline(resident.timeline, {
      event,
      sequence,
      ...timelineSequenceOptions(event),
      ...(event.sequence === undefined || sequence === resident.timeline.lastSequence
        ? { advanceSequence: false as const }
        : {}),
    })
    this.rememberLiveBodies(resident, event, previous)
    if (isRetainedHostNotice(event))
      this.rememberNotices(
        resident.sessionId,
        resident.timeline.nodes.filter((node) => !previous.includes(node)),
        previous
          .slice(-4)
          .map((node) => node.id)
          .reverse(),
        event.type === 'session.gap' ? { from: event.fromSequence, to: event.toSequence } : undefined,
      )
    this.rememberChanges(resident, previous, event, event.sequence)
    const nodeBudget = resident.expanded === true ? TRANSCRIPT_MAX_NODES : 256
    if (
      !this.visible &&
      (event.type === 'message.delta' ||
        event.type === 'reasoning.delta' ||
        (event.type === 'tool.updated' &&
          (event.tool.status === 'running' || event.tool.status === 'queued'))) &&
      resident.timeline.nodes.length === previous.length &&
      resident.timeline.nodes.length < nodeBudget - 32
    ) {
      resident.boundDirty = true
    } else {
      resident.boundDirty = false
      this.bound(resident)
    }
    this.updateCurrentTodos(resident, event)
  }

  private applyTailEvent(event: BackendEvent): void {
    if (this.tail === undefined) return
    const previous = this.tail.timeline
    this.reduce(this.tail, event)
    if (this.displayed === this.tail && this.tail.timeline !== previous) {
      this.revision++
      this.schedule(event.type === 'tool.updated')
    }
  }

  private flushIngress(urgent = false, publish = true): void {
    if (this.needsRebase || this.ingress.size === 0 || this.tail === undefined) return
    for (const event of this.ingress.take(
      (first) =>
        first.transientAttemptId === undefined ||
        first.transientSequence === 1 ||
        !this.tail!.timeline.nodes.some(
          (node) =>
            (node.kind === 'assistant-message' || node.kind === 'reasoning') &&
            node.liveAttemptId === first.transientAttemptId &&
            node.liveLastIndex !== undefined &&
            first.transientIndex !== undefined &&
            node.liveLastIndex >= first.transientIndex,
        ),
    ))
      this.reduce(this.tail, event)
    if (this.displayed === this.tail) {
      this.revision++
      this.dirty = true
      if (publish) this.schedule(urgent)
    }
  }

  private invalidateIngress(): void {
    if (!this.visible || this.invalidated || this.tail === undefined) return
    this.invalidated = true
    this.deps.invalidate?.(this.tail.sessionId)
  }

  private noteOverload(): void {
    this.previewCanResume()
    this.overloadBudget.count++
  }

  private previewCanResume(): boolean {
    if (performance.now() - this.overloadBudget.started >= 10_000)
      this.overloadBudget = { started: performance.now(), count: 0 }
    return this.overloadBudget.count < 3
  }

  /** Repair only this bounded view; ordinary packet loss needs no upstream read. */
  public async resync(sessionId: string, signal: AbortSignal): Promise<TranscriptWindow> {
    if (this.displayed?.sessionId !== sessionId || this.tail === undefined) throw stale()
    if (this.needsRebase) {
      const child = this.tail.child
      const cwd = this.tail.cwd
      const generation = this.begin(sessionId, child, true)
      try {
        await this.deps.refresh?.(sessionId)
        signal.throwIfAborted()
        const page = await this.deps.read(sessionId, undefined, signal, child)
        signal.throwIfAborted()
        return this.installPage(sessionId, page, generation, cwd)
      } catch (error) {
        if (this.generation === generation) {
          this.needsRebase = true
          this.deps.onCapacity?.(false)
          this.invalidated = false
        }
        throw error
      } finally {
        this.cancel(generation)
      }
    }
    this.flushIngress(false, false)
    this.deliveryEpoch++
    this.deliverySuspended = false
    this.cancelRecovery()
    this.invalidated = false
    this.published = undefined
    this.pendingAcks.clear()
    this.pendingChars = 0
    this.budgetBlocked = false
    this.revision++
    return this.snapshot()
  }

  private ensureProjected(resident: Resident): void {
    if (resident.boundDirty === true) {
      resident.boundDirty = false
      this.bound(resident)
    }
  }

  private reconcileResidentNodes(resident: Resident, previous: Resident): void {
    this.ensureProjected(previous)
    const previousById = new Map(previous.timeline.nodes.map((node) => [node.id, node]))
    if (previousById.size === 0) return
    let reusedAny = false
    const nodes = resident.timeline.nodes.map((node) => {
      const prevNode = previousById.get(node.id)
      if (prevNode === undefined || prevNode === node) return node
      const prevTracked = previous.rawChars.get(node.id)
      const currTracked = resident.rawChars.get(node.id)
      if (prevTracked !== undefined && currTracked !== undefined && prevTracked.chars !== currTracked.chars)
        return node
      if (!sameTimelineValue(prevNode, node)) return node
      reusedAny = true
      if (prevTracked !== undefined) resident.rawChars.set(node.id, prevTracked)
      else if (currTracked !== undefined)
        resident.rawChars.set(node.id, { node: prevNode, chars: currTracked.chars })
      if (resident.liveBodies.has(node.id)) resident.liveBodies.set(node.id, prevNode)
      return prevNode
    })
    if (reusedAny) {
      resident.timeline = { ...resident.timeline, nodes }
    }
  }

  /** A viewport eviction must never turn the next delta into a new partial body. */
  private restoreLiveBody(resident: Resident, event: BackendEvent): void {
    const id =
      event.type === 'tool.updated'
        ? event.tool.id
        : 'messageId' in event && typeof event.messageId === 'string'
          ? event.messageId
          : undefined
    if (id === undefined) return
    const node = resident.liveBodies.get(id)
    // Live bodies are the newest rows, so an existence probe from the tail
    // resolves in a few steps instead of scanning the whole window.
    if (node !== undefined && !containsNodeIdFromEnd(resident.timeline.nodes, node.id))
      resident.timeline = { ...resident.timeline, nodes: [node, ...resident.timeline.nodes] }
  }

  private rememberLiveBodies(
    resident: Resident,
    event: BackendEvent,
    previous: readonly TimelineNode[],
  ): void {
    if (event.type === 'turn.ended' || event.type === 'session.removed') {
      resident.liveBodies.clear()
      return
    }
    const nodes = resident.timeline.nodes
    // Only rows the reducer touched since `previous` can have changed their
    // streaming/running state; earlier rows were already reconciled.
    const start = resident.timeline.nodeChangeBase === previous ? (resident.timeline.nodeChangeStart ?? 0) : 0
    for (let index = start; index < nodes.length; index++) {
      const node = nodes[index]!
      if (node.kind === 'tool') {
        if (node.tool.status === 'running' || node.tool.status === 'queued')
          resident.liveBodies.set(node.id, node)
        else resident.liveBodies.delete(node.id)
      } else if (node.kind === 'assistant-message' || node.kind === 'reasoning') {
        if (node.streaming || (node.kind === 'assistant-message' && node.reasoning?.streaming === true))
          resident.liveBodies.set(node.id, node)
        else resident.liveBodies.delete(node.id)
      }
    }
  }

  private rememberChanges(
    resident: Resident,
    previous: readonly TimelineNode[],
    event: BackendEvent,
    sequence?: number,
    fromSequence = sequence,
  ): void {
    if (resident.timeline.nodes === previous) return
    const start = resident.timeline.nodeChangeBase === previous ? (resident.timeline.nodeChangeStart ?? 0) : 0
    for (let index = start; index < resident.timeline.nodes.length; index++) {
      const node = resident.timeline.nodes[index]!
      const tracked = resident.rawChars.get(node.id)
      if (node === previous[index] || tracked?.node === node) continue
      if (sequence !== undefined) {
        const source = resident.sources.get(node.id)
        resident.sources.set(node.id, {
          from: Math.min(source?.from ?? fromSequence ?? sequence, fromSequence ?? sequence),
          to: sequence,
        })
      }
      const suffix = tracked === undefined ? undefined : appendedNodeSuffix(tracked.node, node, event)
      if (tracked !== undefined && suffix !== undefined)
        this.contentVersions.append(tracked.node, node, suffix)
      resident.rawChars.set(node.id, {
        node,
        chars:
          tracked !== undefined &&
          suffix !== undefined &&
          (tracked.node.kind === 'assistant-message' || tracked.node.kind === 'reasoning')
            ? appendedTextNodeChars(tracked.node, suffix, tracked.chars)
            : JSON.stringify(node).length,
      })
    }
  }

  private updateCurrentTodos(resident: Resident, event: BackendEvent): void {
    if (resident.nativeTodos || event.type !== 'todo.updated') return
    const result = preview({ kind: 'todo', id: 'current-todos', todos: event.todos }, TRANSCRIPT_NODE_CHARS)
    resident.currentTodos = result.value.kind === 'todo' ? result.value.todos : []
    if (result.omitted) resident.currentTodosOmitted = true
    else delete resident.currentTodosOmitted
  }

  private rememberIdentity(event: BackendEvent, sequence: number): void {
    this.recentEvents.set(eventIdentity(event, sequence), true)
    if (this.recentEvents.size > 512) this.recentEvents.delete(this.recentEvents.keys().next().value!)
  }

  private rememberNotices(
    sessionId: string,
    nodes: readonly TimelineNode[],
    anchors: readonly string[],
    range?: { from: number; to: number },
  ): void {
    const entries = [...(this.notices.get(sessionId) ?? [])]
    for (const node of nodes)
      if (
        (node.kind === 'command-input' || node.kind === 'notice') &&
        !entries.some((entry) => entry.node.id === node.id)
      ) {
        const chars = JSON.stringify(node).length
        if (chars <= 512 * 1024)
          entries.push({ node, anchors, chars, ...(range === undefined ? {} : { range }) })
      }
    while (entries.length > 128) entries.shift()
    this.notices.delete(sessionId)
    this.notices.set(sessionId, entries)
    const size = (): number => [...this.notices.values()].flat().reduce((sum, entry) => sum + entry.chars, 0)
    while (this.notices.size > 16 || size() > 512 * 1024)
      this.notices.delete(this.notices.keys().next().value!)
  }

  private rememberFact(
    resident: Resident,
    event: BackendEvent,
    sequence: number,
    representedSequences: number,
  ): void {
    const coords: { turn?: number; step?: number; attempt?: number } = {}
    if ('turn' in event && typeof event.turn === 'number') coords.turn = event.turn
    if ('step' in event && typeof event.step === 'number') coords.step = event.step
    if ('attempt' in event && typeof event.attempt === 'number') coords.attempt = event.attempt
    resident.facts.push({
      id: `event:${sequence}:${event.type}:${++resident.factCounter}`,
      type: event.type,
      sequence,
      representedSequences,
      ...coords,
    })
    if (resident.facts.length > 256) resident.facts.shift()
  }

  private bound(resident: Resident, preferOlder = false): void {
    let remaining = TRANSCRIPT_MAX_CHARS - 128 * 1024
    const nodeBudget = resident.expanded === true ? TRANSCRIPT_MAX_NODES : 256
    const nodes: TimelineNode[] = []
    const source = resident.timeline.nodes
    // Walk newest-first (oldest-first for a backfill merge) without copying
    // the retained table; this runs for every accepted event.
    let cursor = preferOlder ? 0 : source.length - 1
    const step = preferOlder ? 1 : -1
    const nextCandidate = (): TimelineNode | undefined => {
      while (cursor >= 0 && cursor < source.length) {
        const candidate = source[cursor]!
        cursor += step
        if (!resident.contextIds.has(candidate.id)) return candidate
      }
      return undefined
    }
    const projectNode = (
      original: TimelineNode,
    ): {
      value: TimelineNode
      omitted: boolean
      size: number
      rawSize: number
      contentOmitted: boolean
      publicCwd: string | undefined
    } => {
      let clipped = this.previews.get(original)
      if (clipped === undefined) {
        const tracked = resident.rawChars.get(original.id)
        const rawSize = tracked?.node === original ? tracked.chars : JSON.stringify(original).length
        const projected = preview(
          original,
          isMessageNode(original)
            ? rawSize > MESSAGE_NODE_CHARS
              ? 64 * 1024
              : MESSAGE_NODE_CHARS
            : TRANSCRIPT_NODE_CHARS,
          undefined,
          rawSize,
        )
        const node = projected.value
        clipped = {
          value: node,
          omitted: projected.omitted,
          contentOmitted: projected.omitted,
          publicCwd: resident.cwd,
          size: node === original ? rawSize : JSON.stringify(node).length,
          rawSize,
        }
        if (
          original.kind === 'tool' &&
          !transcriptNodeSchema.safeParse(this.deps.publicValue(node, resident.cwd)).success
        )
          clipped.omitted = true
        this.previews.set(original, clipped)
        this.previews.set(node, clipped)
      }
      if (clipped.publicCwd !== resident.cwd) {
        clipped.publicCwd = resident.cwd
        clipped.omitted =
          clipped.contentOmitted ||
          (original.kind === 'tool' &&
            !transcriptNodeSchema.safeParse(this.deps.publicValue(clipped.value, resident.cwd)).success)
      }
      return clipped
    }
    while (nodes.length < nodeBudget - 32) {
      const original = nextCandidate()
      if (original === undefined) break
      const clipped = projectNode(original)
      const node = clipped.value
      const size = clipped.size
      if (
        size > remaining ||
        (clipped.rawSize > remaining && nodes.length > 0 && !resident.liveBodies.has(original.id))
      )
        break
      const versionChars = clipped.omitted ? JSON.stringify(original.id).length + 68 : 0
      remaining = Math.max(
        0,
        remaining - (resident.liveBodies.has(original.id) ? size : clipped.rawSize) - versionChars,
      )
      // Keep the single canonical body. Only publication projects a bounded
      // transport representation, so later deltas can never append to lost text.
      // The position sort below restores order after this newest-first walk.
      nodes.push(original)
      if (clipped.omitted) resident.omitted.add(node.id)
      else resident.omitted.delete(node.id)
    }
    // Context parents preserve supplied call identities and pairing, while
    // the actual page boundary follows the contiguous display rows below.
    let byId: Map<string, TimelineNode> | undefined
    let normalIds: Set<string> | undefined
    const contextIds = new Set<string>()
    let contextChars = 64 * 1024
    const normalCount = nodes.length
    for (let index = 0; index < normalCount; index++) {
      const node = nodes[index]!
      // Only a child tool can enter the ancestor walk. Streaming prose used
      // to allocate an unused cycle-guard Set for every retained row.
      if (node.kind !== 'tool' || node.tool.parentCallId === undefined) continue
      let parentId: string | undefined = node.tool.parentCallId
      const visited = new Set<string>()
      while (parentId !== undefined && !visited.has(parentId)) {
        visited.add(parentId)
        byId ??= new Map(source.map((node) => [node.id, node]))
        const parent = byId.get(parentId)
        if (parent?.kind !== 'tool') break
        normalIds ??= new Set(nodes.map((node) => node.id))
        if (!normalIds.has(parentId) && !contextIds.has(parentId)) {
          const clipped = projectNode(parent)
          if (contextIds.size >= 32 || clipped.rawSize > contextChars) break
          contextChars -= clipped.rawSize
          contextIds.add(parentId)
          nodes.push(parent)
          if (clipped.omitted) resident.omitted.add(parentId)
        }
        parentId = parent.tool.parentCallId
      }
    }
    if (contextIds.size > 0) {
      const positionsById = new Map(source.map((node, index) => [node.id, index]))
      nodes.sort((left, right) => (positionsById.get(left.id) ?? 0) - (positionsById.get(right.id) ?? 0))
    } else if (!preferOlder) nodes.reverse()
    resident.contextIds = contextIds
    const kept = new Set(nodes.map((node) => node.id))
    for (const id of resident.omitted) if (!kept.has(id)) resident.omitted.delete(id)
    for (const id of resident.sources.keys()) if (!kept.has(id)) resident.sources.delete(id)
    for (const id of resident.rawChars.keys()) if (!kept.has(id)) resident.rawChars.delete(id)
    const evicted = source.length > nodes.length
    // All bookkeeping is bounded too; a partial turn never claims exact aggregate usage.
    const tracking = Object.entries(resident.timeline.turnUsageTracking ?? {})
      .slice(-8)
      .map(
        ([key, value]) =>
          [key, value.attempts.length > 256 ? { ...value, invalid: true, attempts: [] } : value] as const,
      )
    const { nodeChangeBase: _base, closedTurns, ...rest } = resident.timeline
    void _base
    resident.timeline = {
      ...rest,
      nodes,
      nodeChangeStart: 0,
      ...(closedTurns === undefined ? {} : { closedTurns: closedTurns.slice(-64) }),
      stepTimings: Object.fromEntries(Object.entries(resident.timeline.stepTimings ?? {}).slice(-64)),
      turnUsageTracking: Object.fromEntries(tracking),
      commandModes: Object.fromEntries(Object.entries(resident.timeline.commandModes ?? {}).slice(-64)),
    }
    if (evicted && !preferOlder) {
      resident.hasMore = true
      // Evicted rows stay in DSH. Their raw boundary, not a display index, enables rereading.
      const positions = [...resident.sources]
        .filter(([id]) => !contextIds.has(id))
        .map(([, source]) => source.from)
      if (positions.length > 0) resident.before = Math.min(...positions)
    }
  }

  private snapshot(nodeIds?: ReadonlySet<string>, flush = true): TranscriptWindow {
    if (flush) this.flushIngress(false, false)
    const resident = this.displayed
    if (resident === undefined) throw stale()
    this.ensureProjected(resident)
    const safe = this.deps.publicValue(
      {
        sessionId: resident.sessionId,
        revision: this.revision,
        nodes:
          nodeIds === undefined
            ? resident.timeline.nodes.map((node) => this.previews.get(node)?.value ?? node)
            : resident.timeline.nodes
                .filter((node) => nodeIds.has(node.id))
                .map((node) => this.previews.get(node)?.value ?? node),
        eventFacts: resident.facts,
        ...(this.tail?.currentTodos === undefined ? {} : { currentTodos: this.tail.currentTodos }),
        ...(this.tail?.currentTodosOmitted === true ? { currentTodosOmitted: true } : {}),
        lastSequence: resident.timeline.lastSequence,
        hasMore: resident.hasMore,
        historical: resident !== this.tail,
        omittedNodeIds: [...resident.omitted],
        ...(resident.omitted.size === 0 ? {} : { contentVersions: this.omittedContentVersions(resident) }),
        ...(resident.before === undefined ? {} : { beforeSequence: resident.before }),
        ...(resident.timeline.activeTurn === undefined ? {} : { activeTurn: resident.timeline.activeTurn }),
        ...(resident.timeline.tokenUsage === undefined ? {} : { tokenUsage: resident.timeline.tokenUsage }),
      },
      resident.cwd,
    )
    if (typeof safe === 'object' && safe !== null && 'nodes' in safe && Array.isArray(safe.nodes)) {
      safe.nodes = safe.nodes.map((node: unknown) => {
        if (transcriptNodeSchema.safeParse(node).success) return node
        // A path outside the workspace removes a required read/diff field.
        // Degrade that card alone, just as the existing public event mapper does.
        if (
          typeof node === 'object' &&
          node !== null &&
          'kind' in node &&
          node.kind === 'tool' &&
          'tool' in node &&
          typeof node.tool === 'object' &&
          node.tool !== null
        ) {
          const { presentation: _presentation, ...tool } = node.tool as Record<string, unknown>
          void _presentation
          const fallback = { ...node, tool }
          transcriptNodeSchema.parse(fallback)
          return fallback
        }
        transcriptNodeSchema.parse(node)
        return node
      })
    }
    return transcriptWindowSchema.parse(safe) as TranscriptWindow
  }

  /** Compare source identities before sanitizing unchanged metadata again. */
  private omittedContentVersions(resident: Resident): Readonly<Record<string, string>> {
    return Object.fromEntries(
      resident.timeline.nodes
        .filter((node) => resident.omitted.has(node.id))
        .map((node) => [node.id, this.contentVersions.key(node)]),
    )
  }

  private metadataSource(resident: Resident): WindowMetadataSource {
    return {
      facts: resident.factCounter,
      lastSequence: resident.timeline.lastSequence,
      activeTurn: resident.timeline.activeTurn,
      tokenUsage: resident.timeline.tokenUsage,
      hasMore: resident.hasMore,
      before: resident.before,
      historical: resident !== this.tail,
      omitted: JSON.stringify([...resident.omitted]),
      contentVersions:
        resident.omitted.size === 0 ? '' : JSON.stringify(this.omittedContentVersions(resident)),
      todos: this.tail?.currentTodos,
      todosOmitted: this.tail?.currentTodosOmitted,
    }
  }

  private schedule(urgent = false): void {
    this.dirty = true
    // A single ACK round trip must not become the streaming frame interval.
    // Keep a small credit window; stalled/hidden renderers still retain only
    // the newest Host state, never an unbounded queue of text deltas.
    const credits = this.deps.postPatch === undefined ? 1 : 64
    // One reserved frame lets an executed tool's context precede its question
    // even while ordinary streaming has exhausted its delivery credits.
    if (
      (!this.visible && !urgent) ||
      this.deliverySuspended ||
      this.posting ||
      (!urgent && this.budgetBlocked) ||
      this.pendingAcks.size >= credits + (urgent ? 1 : 0)
    )
      return
    void this.publish(urgent)
  }

  private clearRetry(): void {
    this.retryAttempt = 0
    this.recoveryAttempt = 0
    this.cancelRecovery()
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
  }

  private scheduleDeliveryRecovery(): void {
    const delay = DELIVERY_RECOVERY_DELAYS[this.recoveryAttempt] ?? DELIVERY_RECOVERY_MAX_DELAY
    if (!this.visible || this.displayed === undefined || this.recoveryTimer !== undefined) return
    const generation = this.generation
    const resident = this.displayed
    this.recoveryAttempt++
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      if (
        !this.visible ||
        generation !== this.generation ||
        resident !== this.displayed ||
        !this.deliverySuspended
      )
        return
      this.deliverySuspended = false
      this.schedule()
    }, delay)
    this.recoveryTimer.unref?.()
  }

  /**
   * A failed post leaves the newest window untouched in the renderer. Retry a
   * bounded number of times, then ask for the same reread a sequence gap uses.
   * Delayed latest-window posts cover a lost recovery notification. After the
   * fast attempts, a visible view is probed at most once every ten seconds.
   * They never reread DSH or queue historical frames.
   */
  private retryDelivery(): void {
    this.dirty = true
    const retrying = this.retryAttempt < DELIVERY_RETRY_LIMIT
    this.deps.report?.({ attempt: this.retryAttempt + this.recoveryAttempt + 1, retrying })
    if (!retrying) {
      this.deliverySuspended = true
      this.scheduleDeliveryRecovery()
      const sessionId = this.displayed?.sessionId
      if (this.invalidated || sessionId === undefined) return
      this.invalidated = true
      this.deps.invalidate?.(sessionId)
      return
    }
    this.retryAttempt += 1
    this.schedule()
  }

  private async publish(urgent = false): Promise<void> {
    if ((!this.visible && !urgent) || this.displayed === undefined) return
    if (this.tail !== undefined) this.ensureProjected(this.tail)
    this.ensureProjected(this.displayed)
    this.dirty = false
    this.posting = true
    const sentRevision = this.revision
    const generation = this.generation
    const deliveryEpoch = this.deliveryEpoch
    const resident = this.displayed
    try {
      const sources = new Map(resident.timeline.nodes.map((node) => [node.id, node]))
      const previous = this.published
      const postPatch = this.deps.postPatch
      const base =
        this.deps.postPatch !== undefined &&
        previous?.sessionId === resident.sessionId &&
        previous.cwd === resident.cwd &&
        previous.revision < sentRevision
          ? previous
          : undefined
      const changedIds =
        base === undefined
          ? undefined
          : new Set(
              resident.timeline.nodes
                .filter((node) => base.nodes.get(node.id) !== node)
                .map((node) => node.id),
            )
      // A patch is only valid while the renderer's node order still matches:
      // every previously published id keeps its position and new ids append.
      // Anything else (removal, eviction, reorder) ships a full window instead.
      const incremental =
        base !== undefined &&
        changedIds !== undefined &&
        changedIds.size < sources.size &&
        keepsNodeOrder(base.nodes, resident.timeline.nodes)
      const metadataSource = this.metadataSource(resident)
      const metadataChanged =
        base === undefined ||
        Object.entries(metadataSource).some(
          ([key, value]) => value !== base.metadataSource[key as keyof typeof metadataSource],
        )
      // Sanitize and validate only changed nodes on the hot path. Unchanged
      // public nodes already live in the acknowledged renderer window, and the
      // patch deliberately omits the node-id list and event facts: re-sending
      // them per token made a streamed revision cost O(window) bytes.
      // Transient text leaves durable facts and page metadata untouched. Do not
      // sanitize/clone that entire window for every token.
      const window =
        incremental && !metadataChanged
          ? {
              sessionId: resident.sessionId,
              revision: sentRevision,
              nodes: this.publicNodes(resident, changedIds),
            }
          : this.snapshot(incremental ? changedIds : undefined, false)
      const publicNodes = new Map(incremental ? base?.publicNodes : undefined)
      for (const node of window.nodes) publicNodes.set(node.id, node)
      let patch: TranscriptPatch | undefined
      if (incremental && postPatch !== undefined && base !== undefined) {
        const changedNodes: TimelineNode[] = []
        const textUpdates: TranscriptTextUpdate[] = []
        for (const node of window.nodes) {
          const update = textUpdate(base.publicNodes.get(node.id), node)
          if (update === undefined) changedNodes.push(node)
          else textUpdates.push(update)
        }
        let metadata
        if ('eventFacts' in window) {
          const { sessionId: _id, revision: _revision, nodes: _nodes, ...values } = window
          void _id
          void _revision
          void _nodes
          metadata = values
        }
        patch = transcriptPatchSchema.parse({
          sessionId: window.sessionId,
          revision: window.revision,
          baseRevision: base.revision,
          changedNodes,
          ...(textUpdates.length === 0 ? {} : { textUpdates }),
          ...(metadata === undefined ? {} : { metadata }),
        }) as TranscriptPatch
      }
      const chars = JSON.stringify(patch ?? window).length
      if (!urgent && this.pendingAcks.size > 0 && this.pendingChars + chars > 512 * 1024) {
        this.dirty = true
        this.budgetBlocked = true
        return
      }
      this.pendingAcks.set(sentRevision, chars)
      this.pendingChars += chars
      // VS Code preserves invocation order on a Webview. Reserve this baseline
      // before awaiting its receipt, so the next delta can enter IPC immediately.
      this.published = {
        sessionId: window.sessionId,
        revision: sentRevision,
        cwd: resident.cwd,
        nodes: sources,
        publicNodes,
        metadataSource,
      }
      this.posting = false
      const delivered =
        patch !== undefined && postPatch !== undefined
          ? await postPatch(patch)
          : 'eventFacts' in window && (await this.deps.post(window))
      if (
        this.generation !== generation ||
        this.deliveryEpoch !== deliveryEpoch ||
        this.displayed !== resident
      )
        return
      if (!delivered) {
        this.deliveryEpoch++
        this.pendingAcks.clear()
        this.pendingChars = 0
        this.budgetBlocked = false
        this.published = undefined
        this.retryDelivery()
      } else {
        this.invalidated = false
        this.clearRetry()
        // A healthy renderer may have missed the earlier gap notification.
        if (this.needsRebase) this.invalidateIngress()
      }
    } catch {
      if (
        this.generation !== generation ||
        this.deliveryEpoch !== deliveryEpoch ||
        this.displayed !== resident
      )
        return
      this.deliveryEpoch++
      this.pendingAcks.clear()
      this.pendingChars = 0
      this.budgetBlocked = false
      this.published = undefined
      this.posting = false
      this.retryDelivery()
    } finally {
      this.posting = false
    }
    if (this.dirty && this.visible && sentRevision !== this.revision) this.schedule()
  }

  private publicNodes(resident: Resident, ids: ReadonlySet<string>): TimelineNode[] {
    const safe = this.deps.publicValue(
      {
        nodes: resident.timeline.nodes
          .filter((node) => ids.has(node.id))
          .map((node) => this.previews.get(node)?.value ?? node),
      },
      resident.cwd,
    )
    if (typeof safe !== 'object' || safe === null || !('nodes' in safe) || !Array.isArray(safe.nodes))
      throw stale()
    return safe.nodes.map((node: unknown) => {
      const parsed = transcriptNodeSchema.safeParse(node)
      if (parsed.success) return parsed.data as TimelineNode
      // Keep the same out-of-workspace tool-card fallback as full snapshots.
      if (
        typeof node === 'object' &&
        node !== null &&
        'kind' in node &&
        node.kind === 'tool' &&
        'tool' in node &&
        typeof node.tool === 'object' &&
        node.tool !== null
      ) {
        const { presentation: _presentation, ...tool } = node.tool as Record<string, unknown>
        void _presentation
        return transcriptNodeSchema.parse({ ...node, tool }) as TimelineNode
      }
      return transcriptNodeSchema.parse(node) as TimelineNode
    })
  }
}

/** Prove only the text append; all other node fields are measured separately. */
function appendedNodeSuffix(
  previous: TimelineNode,
  next: TimelineNode,
  event: BackendEvent,
): Extract<TimelineNode, { kind: 'assistant-message' | 'reasoning' }> | undefined {
  if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') return undefined
  if (event.messageId !== next.id) return undefined
  if (
    next.kind === 'reasoning' &&
    previous.kind === 'reasoning' &&
    event.type === 'reasoning.delta' &&
    next.markdown.length === previous.markdown.length + event.delta.length
  )
    return { ...next, markdown: event.delta }
  if (next.kind !== 'assistant-message' || previous.kind !== 'assistant-message') return undefined
  const oldReasoning = previous.reasoning?.markdown ?? ''
  const newReasoning = next.reasoning?.markdown ?? ''
  const markdownAppend =
    event.type === 'message.delta' &&
    next.markdown.length === previous.markdown.length + event.delta.length &&
    newReasoning === oldReasoning
  const reasoningAppend =
    event.type === 'reasoning.delta' &&
    next.markdown === previous.markdown &&
    newReasoning.length === oldReasoning.length + event.delta.length
  if (!markdownAppend && !reasoningAppend) return undefined
  return {
    ...next,
    markdown: markdownAppend ? event.delta : '',
    ...(next.reasoning === undefined
      ? {}
      : {
          reasoning: { ...next.reasoning, markdown: reasoningAppend ? event.delta : '' },
        }),
  }
}

function textUpdate(
  previous: TimelineNode | undefined,
  next: TimelineNode,
): TranscriptTextUpdate | undefined {
  if (
    (next.kind !== 'assistant-message' && next.kind !== 'reasoning') ||
    previous?.kind !== next.kind ||
    !('markdown' in previous) ||
    !next.markdown.startsWith(previous.markdown)
  )
    return undefined
  const oldReasoning = previous.kind === 'assistant-message' ? (previous.reasoning?.markdown ?? '') : ''
  if (
    next.kind === 'assistant-message' &&
    next.reasoning !== undefined &&
    !next.reasoning.markdown.startsWith(oldReasoning)
  )
    return undefined
  // Small new nodes cost less as replacements than as append envelopes.
  if (previous.markdown.length + oldReasoning.length < 256) return undefined
  const node = {
    ...next,
    markdown: next.markdown.slice(previous.markdown.length),
    ...(next.kind === 'assistant-message' && next.reasoning !== undefined
      ? { reasoning: { ...next.reasoning, markdown: next.reasoning.markdown.slice(oldReasoning.length) } }
      : {}),
  }
  return {
    node,
    markdownLength: previous.markdown.length,
    ...(next.kind === 'assistant-message' && next.reasoning !== undefined
      ? { reasoningLength: oldReasoning.length }
      : {}),
  }
}

function empty(sessionId: string): TimelineState {
  return { sessionId, nodes: [], lastSequence: -1, eventCount: 0 }
}
function eventIdentity(event: BackendEvent, sequence: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...event, sequence }))
    .digest('hex')
}

/**
 * Whether a patch keeps the renderer's node order: every previously published
 * id still occupies its position, and new ids only append at the tail.
 */
function keepsNodeOrder(
  published: ReadonlyMap<string, TimelineNode>,
  next: readonly TimelineNode[],
): boolean {
  let index = 0
  for (const id of published.keys()) {
    if (next[index]?.id !== id) return false
    index += 1
  }
  return true
}
function assistantKey(
  event: Extract<
    BackendEvent,
    { type: 'message.delta' | 'reasoning.delta' | 'message.completed' | 'assistant.attempt' }
  >,
): string {
  return event.turn !== undefined && event.step !== undefined
    ? `${event.turn}:${event.step}`
    : 'messageId' in event
      ? event.messageId
      : ''
}
/** Existence probe from the tail: live rows are the newest in the window. */
function containsNodeIdFromEnd(nodes: readonly TimelineNode[], id: string): boolean {
  for (let index = nodes.length - 1; index >= 0; index--) if (nodes[index]!.id === id) return true
  return false
}

function stale(): AppError {
  return new AppError({
    code: 'STALE_INTERACTION',
    message: 'The transcript window changed. Reopen the session and retry.',
    retryable: true,
  })
}
export function isTranscriptEvent(event: BackendEvent): boolean {
  return ![
    'session.status',
    'session.activity',
    'session.title',
    'session.subscribed',
    'session.projection',
    'session.projection.baseline',
    'session.configuration',
    'session.system',
    'subagent.catalog.updated',
    'session.added',
    'session.removed',
    'workspace.changed',
    'workspace.order.changed',
    'workspace.removed',
    'queue.updated',
    'jobs.updated',
    'job.follow.updated',
    'job.follow.failed',
    'permission.requested',
    'permission.resolved',
    'question.requested',
    'question.resolved',
    'question.reply.status',
    'connection.lost',
    'connection.restored',
    'archived.sessions.changed',
    'remote.event',
  ].includes(event.type)
}

/** Native command receipts replay from the journal; retaining them as Host
 * notices loses run/done pairing and appends them again on every reopen. */
function isRetainedHostNotice(event: BackendEvent): boolean {
  return (
    event.type === 'session.gap' ||
    (event.type === 'notice' &&
      event.sequence === undefined &&
      (event.commandPhase === undefined || event.commandName !== undefined))
  )
}

export function isTranscriptOnlyEvent(event: BackendEvent): boolean {
  return (
    isTranscriptEvent(event) &&
    (!['turn.started', 'turn.ended', 'goal.updated', 'workflow.updated'].includes(event.type) ||
      (event.replayed === true && (event.type === 'turn.started' || event.type === 'turn.ended')))
  )
}

function isMessageNode(node: TimelineNode): boolean {
  return node.kind === 'assistant-message' || node.kind === 'user-message' || node.kind === 'reasoning'
}

/** Bound every body and nested collection; omission is explicit and reversible through DSH. */
function preview(
  value: TimelineNode,
  budget: number,
  markdownLimit = budget,
  knownChars?: number,
): { value: TimelineNode; omitted: boolean } {
  if (isMessageNode(value) && (knownChars ?? JSON.stringify(value).length) <= budget)
    return { value, omitted: false }
  let remaining = budget
  let omitted = false
  let visited = 0
  const visit = (input: unknown, depth: number, field?: string, streaming = false): unknown => {
    if (++visited > 1024) {
      omitted = true
      return null
    }
    if (typeof input === 'string') {
      const messageMarkdown = isMessageNode(value) && field === 'markdown'
      const limit = Math.max(0, Math.min(messageMarkdown ? markdownLimit : 4096, remaining))
      // Leave room for further suffix appends after advancing a long live
      // window. Keeping only the prefix would hide every later token until
      // completion. Settled history keeps its opening and a full-content route.
      const output =
        limit === 0
          ? ''
          : messageMarkdown && streaming && input.length > limit
            ? input.slice(-Math.min(limit, 64 * 1024))
            : field === 'outputSummary' && input.length > limit && limit > 16
              ? `${input.slice(0, Math.floor((limit - 3) / 2))}\n…\n${input.slice(-Math.ceil((limit - 3) / 2))}`
              : input.slice(0, limit)
      remaining -= output.length
      if (output.length < input.length) omitted = true
      return output
    }
    if (input === null || typeof input !== 'object') return input
    if (depth > 12) {
      omitted = true
      return null
    }
    if (Array.isArray(input)) {
      const output = input.slice(0, 64).map((entry) => visit(entry, depth + 1))
      if (input.length > 64) omitted = true
      return output
    }
    const output = Object.create(null) as Record<string, unknown>
    for (const [key, entry] of Object.entries(input).slice(0, 64))
      output[key] = visit(entry, depth + 1, key, 'streaming' in input && input.streaming === true)
    if (Object.keys(input).length > 64) omitted = true
    return output
  }
  const candidate = visit(value, 0)
  const parsed = transcriptNodeSchema.safeParse(withoutHostCwd(candidate))
  if (parsed.success && JSON.stringify(candidate).length <= budget)
    return { value: omitted ? (parsed.data as TimelineNode) : value, omitted }
  // Raw characters do not account for JSON escaping or combined thinking and
  // answer bodies. Reduce the prose allowance before degrading a valid message
  // into a notice, which would also remove its full-content controls.
  if (isMessageNode(value) && markdownLimit > 0) return preview(value, budget, Math.floor(markdownLimit / 2))
  if (value.kind === 'tool')
    return {
      value: {
        kind: 'tool',
        id: value.id,
        ...(value.sequence === undefined ? {} : { sequence: value.sequence }),
        tool: {
          id: value.tool.id,
          name: value.tool.name.slice(0, 512),
          category: value.tool.category.slice(0, 512),
          title: value.tool.title.slice(0, 512),
          status: value.tool.status,
          ...(value.tool.parentCallId === undefined ? {} : { parentCallId: value.tool.parentCallId }),
          ...(value.tool.turn === undefined ? {} : { turn: value.tool.turn }),
          ...(value.tool.step === undefined ? {} : { step: value.tool.step }),
          inputSummary: value.tool.inputSummary?.slice(0, 2048) ?? '',
          outputSummary: value.tool.outputSummary?.slice(0, 2048) ?? '',
          ...(value.tool.error === undefined ? {} : { error: value.tool.error.slice(0, 1024) }),
          ...(value.tool.autoReviewDenial === undefined
            ? {}
            : {
                autoReviewDenial: {
                  ...(value.tool.autoReviewDenial.reason === undefined
                    ? {}
                    : { reason: value.tool.autoReviewDenial.reason.slice(0, 1024) }),
                },
              }),
          ...(value.tool.images === undefined ? {} : { images: value.tool.images.slice(0, 4) }),
          ...(value.tool.startedAt === undefined ? {} : { startedAt: value.tool.startedAt }),
          ...(value.tool.completedAt === undefined ? {} : { completedAt: value.tool.completedAt }),
          metadata: {},
        },
      },
      omitted: true,
    }
  return {
    value: { kind: 'notice', id: value.id, level: 'info', text: '…' },
    omitted: true,
  }
}

function withoutHostCwd(candidate: unknown): unknown {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('tool' in candidate) ||
    typeof candidate.tool !== 'object' ||
    candidate.tool === null ||
    !('presentation' in candidate.tool)
  )
    return candidate
  const presentation = candidate.tool.presentation
  if (typeof presentation !== 'object' || presentation === null || !('cwd' in presentation)) return candidate
  const { cwd: _cwd, ...view } = presentation
  void _cwd
  return { ...candidate, tool: { ...candidate.tool, presentation: view } }
}
