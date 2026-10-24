import { createHash } from 'node:crypto'
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
interface PendingOpen {
  readonly sessionId: string
  readonly generation: number
  readonly child: boolean
  events: BackendEvent[]
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
  readonly todos: readonly TodoView[] | undefined
  readonly todosOmitted: true | undefined
}

/** A presentation cache. DSH owns durable ordering, recovery and domain projections. */
export class TranscriptWindowService {
  private generation = 0
  private revision = 0
  private pending: PendingOpen | undefined
  private tail: Resident | undefined
  private displayed: Resident | undefined
  private readonly forward: (number | undefined)[] = []
  private readonly sameSequence = new Set<string>()
  private identitySequence = -1
  private visible = true
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
      readonly report?: (failure: { readonly attempt: number; readonly retrying: boolean }) => void
    },
  ) {}

  public begin(sessionId: string, child = false): number {
    const generation = ++this.generation
    this.deliveryEpoch++
    this.clearRetry()
    this.published = undefined
    this.pending = { sessionId, generation, child, events: [], chars: 0, overflow: false }
    return generation
  }

  public needsRefresh(generation: number): boolean {
    return this.pending?.generation === generation && this.pending.overflow
  }

  public restart(generation: number): void {
    const pending = this.pending
    if (pending?.generation !== generation) return
    pending.events = []
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
    const resident = this.project(sessionId, page, this.pending.child, undefined, cwd)
    if (
      this.pending.cwdKnown &&
      (this.pending.cwdSequence === undefined ||
        this.pending.cwdSequence > (page.projection?.asOfSequence ?? -1))
    ) {
      if (this.pending.cwd === undefined) delete resident.cwd
      else resident.cwd = this.pending.cwd
    }
    const pending = this.pending.events
    this.pending = undefined
    this.tail = resident
    this.displayed = resident
    this.forward.length = 0
    this.invalidated = false
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
    this.revision++
    this.published = undefined
    this.pendingAcks.clear()
    this.pendingChars = 0
    this.budgetBlocked = false
    this.clearRetry()
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
    if (!isTranscriptEvent(event)) return false
    const pending = this.pending
    if (pending !== undefined && pending.sessionId === sessionId && !pending.overflow) {
      const chars = JSON.stringify(event).length
      if (pending.events.length >= 256 || pending.chars + chars > 512 * 1024) {
        pending.events = []
        pending.chars = 0
        pending.overflow = true
      } else {
        pending.events.push(event)
        pending.chars += chars
      }
    }
    if (this.tail !== undefined && this.tail.sessionId === sessionId) {
      const previous = this.tail.timeline
      this.reduce(this.tail, event)
      if (this.displayed === this.tail && this.tail.timeline !== previous) {
        this.revision++
        this.schedule(event.type === 'tool.updated')
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
    if (
      this.tail?.sessionId !== sessionId ||
      this.displayed === undefined ||
      revision > this.revision ||
      (this.displayed !== this.tail && revision !== this.revision)
    )
      throw stale()
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
      this.displayed = this.project(sessionId, page, previous.child, before, previous.cwd)
    }
    this.revision++
    this.published = undefined
    return this.snapshot()
  }

  /** Complete current content, including live bodies outside the transport window. */
  public fullNode(sessionId: string, nodeId: string, revision: number, signal: AbortSignal): TimelineNode {
    const displayed = this.displayed
    if (
      signal.aborted ||
      displayed?.sessionId !== sessionId ||
      revision > this.revision ||
      (displayed !== this.tail && revision !== this.revision)
    )
      throw stale()
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
    this.visible = visible
    if (visible && this.displayed !== undefined) {
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
    for (const [sent, chars] of this.pendingAcks)
      if (sent <= revision) {
        this.pendingAcks.delete(sent)
        this.pendingChars -= chars
        this.budgetBlocked = false
      }
    if (this.dirty) this.schedule()
  }

  public showLatest(sessionId: string): void {
    if (this.tail?.sessionId !== sessionId) return
    this.displayed = this.tail
    this.forward.length = 0
    this.revision++
    this.published = undefined
    this.schedule()
  }

  public dispose(): void {
    ++this.generation
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
      this.rememberLiveBodies(resident, entry.event)
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
        if (!known && sequence >= (resident.before ?? 0) && this.pending === undefined && !this.invalidated) {
          this.invalidated = true
          this.deps.invalidate?.(resident.sessionId)
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
    this.rememberLiveBodies(resident, event)
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
    this.bound(resident)
    this.updateCurrentTodos(resident, event)
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
    if (node !== undefined && !resident.timeline.nodes.some((candidate) => candidate.id === node.id))
      resident.timeline = { ...resident.timeline, nodes: [node, ...resident.timeline.nodes] }
  }

  private rememberLiveBodies(resident: Resident, event: BackendEvent): void {
    if (event.type === 'turn.ended' || event.type === 'session.removed') {
      resident.liveBodies.clear()
      return
    }
    for (const node of resident.timeline.nodes)
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
    const candidates = source.filter((node) => !resident.contextIds.has(node.id))
    if (preferOlder) candidates.reverse()
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
    for (let index = candidates.length - 1; index >= 0 && nodes.length < nodeBudget - 32; index--) {
      const original = candidates[index]!
      const clipped = projectNode(original)
      const node = clipped.value
      const size = clipped.size
      if (
        size > remaining ||
        (clipped.rawSize > remaining && nodes.length > 0 && !resident.liveBodies.has(original.id))
      )
        break
      remaining = Math.max(0, remaining - (resident.liveBodies.has(original.id) ? size : clipped.rawSize))
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
    const normalIds = new Set(nodes.map((node) => node.id))
    const contextIds = new Set<string>()
    let contextChars = 64 * 1024
    const normalCount = nodes.length
    for (let index = 0; index < normalCount; index++) {
      const node = nodes[index]!
      let parentId = node.kind === 'tool' ? node.tool.parentCallId : undefined
      const visited = new Set<string>()
      while (parentId !== undefined && !visited.has(parentId)) {
        visited.add(parentId)
        byId ??= new Map(source.map((node) => [node.id, node]))
        const parent = byId.get(parentId)
        if (parent?.kind !== 'tool') break
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

  private snapshot(nodeIds?: ReadonlySet<string>): TranscriptWindow {
    const resident = this.displayed
    if (resident === undefined) throw stale()
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
      !this.visible ||
      this.posting ||
      (!urgent && this.budgetBlocked) ||
      this.pendingAcks.size >= credits + (urgent ? 1 : 0)
    )
      return
    void this.publish(urgent)
  }

  private clearRetry(): void {
    this.retryAttempt = 0
  }

  /**
   * A failed post leaves the newest window untouched in the renderer. Retry a
   * bounded number of times, then ask for the same reread a sequence gap uses:
   * without this the final frame of a stream could be lost until the next
   * navigation or readiness handshake.
   */
  private retryDelivery(): void {
    this.dirty = true
    const retrying = this.retryAttempt < DELIVERY_RETRY_LIMIT
    this.deps.report?.({ attempt: this.retryAttempt + 1, retrying })
    if (!retrying) {
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
    if (!this.visible || this.displayed === undefined) return
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
          : this.snapshot(incremental ? changedIds : undefined)
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
        this.clearRetry()
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
