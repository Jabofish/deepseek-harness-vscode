import type { BackendEvent, SessionHistoryEvent, SessionSequenceRange } from '@dsh-vscode/domain'
import {
  isRedundantTurnFailureNotice,
  reduceTimeline,
  type TimelineNode,
  type TimelineState,
} from '@dsh-vscode/timeline'

import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import {
  historyCoversSequenceRange,
  historySequenceRanges,
  mergeHistory,
  mergeSequenceRanges,
  oldestHistorySequence,
  sequenceRangesCover,
} from './history-ledger.js'
import {
  hydrateTimelineFromHistoryEvents,
  mergeLiveTransientNodes,
  parseSessionHistoryPage,
} from './history-replay.js'
import { hostOnlyInsertIndex } from './host-message-reducers.js'
import type { AppState, StateSetter } from './types.js'

const MAX_GAP_BACKFILL_PAGES = 4
const GAP_BACKFILL_PAGE_MESSAGES = 200
const MAX_COVERED_HISTORY_SESSIONS = 32
const MAX_HOST_ONLY_NODES_PER_SESSION = 128
const MAX_HOST_ONLY_SESSIONS = 16

/**
 * Sequence holes reach the store as `session.gap` events. The timeline gate
 * drops anything at or below its cursor, so a healed hole can only become
 * visible through a rebuild from the history ledger, and anything history
 * itself is missing has to be refetched through session.history pages.
 */
export function createGapHealing({
  client,
  setState,
  getState,
  getOpenVersion,
  isDisposed,
  flushPendingHistory,
  notifyBatchMs,
}: {
  client: ProtocolClient
  setState: StateSetter
  getState: () => AppState
  /** The open barrier version: backfills and rebuilds bow out once it moves. */
  getOpenVersion: () => number
  isDisposed: () => boolean
  flushPendingHistory: () => void
  notifyBatchMs: number
}): {
  scheduleGapBackfill: (event: Extract<BackendEvent, { type: 'session.gap' }>) => void
  scheduleLedgerRebuild: (sessionId: string) => void
  restoreGapNotices: (
    rebuilt: TimelineState,
    sessionId: string,
    history: readonly SessionHistoryEvent[],
  ) => TimelineState
  restoreHostOnlyNodes: (timeline: TimelineState, sessionId: string) => TimelineState
  rememberHostOnlyNodes: (
    sessionId: string,
    nodes: readonly TimelineNode[],
    anchors: readonly string[],
  ) => void
  rememberCoveredRanges: (sessionId: string, ranges: readonly SessionSequenceRange[]) => void
  dispose: () => void
} {
  const gapBackfills = new Map<
    string,
    { ranges: Array<{ readonly from: number; readonly to: number }>; running: boolean }
  >()
  /**
   * Gap warnings are host-only rows: a rebuild from the durable ledger
   * reconstructs the transcript and would silently drop the warning that part
   * of it never arrived. Keep the announced ranges so every rebuild can
   * re-derive the notice from what history still cannot cover.
   */
  const unhealedGapRanges = new Map<string, readonly SessionSequenceRange[]>()
  /**
   * Raw page coverage per session. A page's presentation rows may legitimately
   * omit sequences (hidden system rows, deltas compacted into one row), so the
   * ledger alone cannot prove an announced hole was read. Remember what each
   * successful page vouched for, otherwise a warning published after a failed
   * attempt outlives the hole it describes.
   */
  const coveredHistoryRanges = new Map<string, readonly SessionSequenceRange[]>()
  let ledgerRebuildTimer: number | undefined
  const gapNoticeId = (sessionId: string, fromSequence: number, toSequence: number): string =>
    `gap:${sessionId}:${fromSequence}:${toSequence}`
  const rememberCoveredRanges = (sessionId: string, ranges: readonly SessionSequenceRange[]): void => {
    if (ranges.length === 0) return
    const merged = mergeSequenceRanges(coveredHistoryRanges.get(sessionId) ?? [], ranges)
    // Re-insert so the least recently read session is evicted first.
    coveredHistoryRanges.delete(sessionId)
    coveredHistoryRanges.set(sessionId, merged)
    while (coveredHistoryRanges.size > MAX_COVERED_HISTORY_SESSIONS) {
      const oldest = coveredHistoryRanges.keys().next().value
      if (oldest === undefined) break
      coveredHistoryRanges.delete(oldest)
    }
  }
  const historyCoversAnnouncedRange = (
    sessionId: string,
    history: readonly SessionHistoryEvent[],
    fromSequence: number,
    toSequence: number,
  ): boolean =>
    historyCoversSequenceRange(history, fromSequence, toSequence) ||
    sequenceRangesCover(coveredHistoryRanges.get(sessionId) ?? [], fromSequence, toSequence)
  /**
   * Reconcile the session's warning rows with the announced ranges: one row per
   * merged range, so an adjacent re-announcement refreshes the existing warning
   * instead of adding a second one for the same contiguous hole.
   */
  const syncGapNotices = (timeline: TimelineState, sessionId: string): TimelineState => {
    const announced = unhealedGapRanges.get(sessionId) ?? []
    const prefix = `gap:${sessionId}:`
    const wanted = new Set(announced.map((range) => gapNoticeId(sessionId, range.from, range.to)))
    const kept = timeline.nodes.filter((node) => !node.id.startsWith(prefix) || wanted.has(node.id))
    let next = kept.length === timeline.nodes.length ? timeline : { ...timeline, nodes: kept }
    for (const range of announced) {
      const id = gapNoticeId(sessionId, range.from, range.to)
      if (next.nodes.some((node) => node.id === id)) continue
      next = reduceTimeline(next, {
        sequence: next.lastSequence,
        event: { type: 'session.gap', sessionId, fromSequence: range.from, toSequence: range.to },
        advanceSequence: false,
      })
    }
    return next
  }
  const publishUnhealedGap = (sessionId: string, fromSequence: number, toSequence: number): void => {
    if (historyCoversAnnouncedRange(sessionId, [], fromSequence, toSequence)) return
    const announced = unhealedGapRanges.get(sessionId) ?? []
    unhealedGapRanges.set(sessionId, mergeSequenceRanges(announced, [{ from: fromSequence, to: toSequence }]))
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      const timeline = syncGapNotices(current.timeline, sessionId)
      return timeline === current.timeline ? current : { ...current, timeline }
    })
  }
  const restoreGapNotices = (
    rebuilt: TimelineState,
    sessionId: string,
    history: readonly SessionHistoryEvent[],
  ): TimelineState => {
    const announced = unhealedGapRanges.get(sessionId)
    if (announced !== undefined) {
      const remaining = announced.filter(
        (range) => !historyCoversAnnouncedRange(sessionId, history, range.from, range.to),
      )
      if (remaining.length === 0) unhealedGapRanges.delete(sessionId)
      else if (remaining.length !== announced.length) unhealedGapRanges.set(sessionId, remaining)
    }
    return syncGapNotices(rebuilt, sessionId)
  }
  /**
   * Command notices and agent errors are host-only rows: DSH never replays
   * them, so every path that rebuilds the transcript - a below-cursor rebuild,
   * a switch back to the session - would silently erase them from the
   * conversation. Remember them per session together with the rows they
   * arrived behind, and put them back at that position.
   */
  const rememberedHostOnlyNodes = new Map<
    string,
    Array<{ readonly node: TimelineNode; readonly anchors: readonly string[] }>
  >()
  const rememberHostOnlyNodes = (
    sessionId: string,
    nodes: readonly TimelineNode[],
    anchors: readonly string[],
  ): void => {
    const remembered = rememberedHostOnlyNodes.get(sessionId) ?? []
    const next = [...remembered]
    for (const node of nodes)
      if (!next.some((entry) => entry.node.id === node.id)) next.push({ node, anchors })
    while (next.length > MAX_HOST_ONLY_NODES_PER_SESSION) next.shift()
    // Re-insert so the least recently active session is evicted first.
    rememberedHostOnlyNodes.delete(sessionId)
    rememberedHostOnlyNodes.set(sessionId, next)
    while (rememberedHostOnlyNodes.size > MAX_HOST_ONLY_SESSIONS) {
      const oldest = rememberedHostOnlyNodes.keys().next().value
      if (oldest === undefined) break
      rememberedHostOnlyNodes.delete(oldest)
    }
  }
  const restoreHostOnlyNodes = (timeline: TimelineState, sessionId: string): TimelineState => {
    const remembered = rememberedHostOnlyNodes.get(sessionId)
    if (remembered === undefined || remembered.length === 0) return timeline
    let nodes: TimelineNode[] | undefined
    // Arrival order is the invariant: rows that arrived later can never end up
    // in front of a row that arrived earlier, whatever their anchors resolve
    // to (rows that arrived before any durable node have no anchor at all).
    let previousIndex = -1
    for (const entry of remembered) {
      const existing = (nodes ?? timeline.nodes).findIndex((node) => node.id === entry.node.id)
      if (existing >= 0) {
        previousIndex = existing
        continue
      }
      const target = nodes ?? timeline.nodes
      // A notice retained for a session that was not open was reduced on its
      // own, so it never saw the durable turn row that carries the same
      // failure. The turn row is the one history replays; drop the twin.
      if (isRedundantTurnFailureNotice(entry.node, target)) continue
      const mutable = nodes ?? (nodes = [...timeline.nodes])
      const index = Math.max(hostOnlyInsertIndex(mutable, entry.anchors), previousIndex + 1)
      mutable.splice(index, 0, entry.node)
      previousIndex = index
    }
    return nodes === undefined
      ? timeline
      : { ...timeline, nodes, nodeChangeBase: timeline.nodes, nodeChangeStart: 0 }
  }
  const rebuildTimelineFromLedger = (sessionId: string): void => {
    flushPendingHistory()
    setState((current) => {
      if (current.activeSessionId !== sessionId) return current
      const rebuilt = hydrateTimelineFromHistoryEvents(sessionId, current.history)
      return {
        ...current,
        timeline: mergeLiveTransientNodes(
          restoreHostOnlyNodes(restoreGapNotices(rebuilt, sessionId, current.history), sessionId),
          current.timeline,
          current.history,
        ),
      }
    })
  }
  const scheduleLedgerRebuild = (sessionId: string): void => {
    // Out-of-order live frames (recovery, re-snapshot
    // redelivery) land in the ledger but are dropped by the timeline cursor.
    // One coalesced rebuild republishes the ledger; a newer open() rebuilds
    // its own baseline anyway, so a stale rebuild just bows out.
    const version = getOpenVersion()
    if (ledgerRebuildTimer !== undefined) clearTimeout(ledgerRebuildTimer)
    ledgerRebuildTimer = window.setTimeout(() => {
      ledgerRebuildTimer = undefined
      if (getOpenVersion() !== version) return
      rebuildTimelineFromLedger(sessionId)
    }, notifyBatchMs)
  }
  const runGapBackfill = async (
    sessionId: string,
    entry: { ranges: Array<{ readonly from: number; readonly to: number }>; running: boolean },
  ): Promise<void> => {
    const version = getOpenVersion()
    try {
      while (entry.ranges.length > 0) {
        if (isDisposed()) return
        const range = entry.ranges.shift()
        if (range === undefined) break
        let beforeSeq = range.to + 1
        // Pages answered after another open superseded this one can no longer
        // be merged into the session's ledger, so the read stops fetching.
        // Stopping must not lose the announcement: the range is still recorded
        // below and the notice is re-derived from the session's own history
        // the next time it is shown.
        for (let page = 0; page < MAX_GAP_BACKFILL_PAGES; page += 1) {
          if (version !== getOpenVersion()) break
          let payload: unknown
          try {
            payload = await client.request<unknown>({
              type: 'session.history',
              requestId: requestId(),
              payload: {
                sessionId,
                beforeSeq,
                maxMessages: GAP_BACKFILL_PAGE_MESSAGES,
                pagePurpose: 'gap-recovery',
              },
            })
          } catch {
            break
          }
          let events: readonly SessionHistoryEvent[]
          let hasMore = false
          let nextBefore: number | undefined
          try {
            const parsed = parseSessionHistoryPage(payload)
            events = parsed.events
            hasMore = parsed.hasMore
            nextBefore = parsed.beforeSequence ?? oldestHistorySequence(parsed.events)
            rememberCoveredRanges(
              sessionId,
              parsed.coveredSequenceRanges ?? historySequenceRanges(parsed.events),
            )
          } catch {
            break
          }
          if (version !== getOpenVersion()) break
          if (events.length === 0) break
          setState((current) =>
            current.activeSessionId === sessionId
              ? { ...current, history: mergeHistory(current.history, events) }
              : current,
          )
          rebuildTimelineFromLedger(sessionId)
          const oldest = oldestHistorySequence(events)
          if (!hasMore || oldest === undefined || oldest <= range.from) break
          if (nextBefore === undefined || nextBefore <= 0) break
          beforeSeq = nextBefore
        }
        // The range memory is per session, so an unhealed hole is recorded even
        // while another session is on screen; the notice itself is re-derived
        // when that session is opened again. Only this session's own history and
        // page windows can vouch for the hole: sequence numbers of another
        // session's history say nothing about it.
        if (!isDisposed()) {
          const current = getState()
          if (
            !historyCoversAnnouncedRange(
              sessionId,
              current.activeSessionId === sessionId ? current.history : [],
              range.from,
              range.to,
            )
          )
            publishUnhealedGap(sessionId, range.from, range.to)
        }
      }
    } finally {
      entry.running = false
      if (entry.ranges.length === 0) gapBackfills.delete(sessionId)
    }
  }
  const scheduleGapBackfill = (event: Extract<BackendEvent, { type: 'session.gap' }>): void => {
    const sessionId = event.sessionId
    const entry = gapBackfills.get(sessionId) ?? { ranges: [], running: false }
    // Merge overlapping/adjacent announcements so a re-announced hole cannot
    // multiply identical page fetches; the merged range still re-fetches once
    // when a previous attempt failed, which keeps the heal self-retrying.
    let from = event.fromSequence
    let to = event.toSequence
    const unmerged: Array<{ readonly from: number; readonly to: number }> = []
    for (const range of entry.ranges) {
      if (range.from <= to + 1 && range.to + 1 >= from) {
        from = Math.min(from, range.from)
        to = Math.max(to, range.to)
      } else unmerged.push(range)
    }
    entry.ranges = [...unmerged, { from, to }]
    gapBackfills.set(sessionId, entry)
    if (entry.running) return
    entry.running = true
    void runGapBackfill(sessionId, entry)
  }
  return {
    scheduleGapBackfill,
    scheduleLedgerRebuild,
    restoreGapNotices,
    restoreHostOnlyNodes,
    rememberHostOnlyNodes,
    rememberCoveredRanges,
    dispose: (): void => {
      if (ledgerRebuildTimer !== undefined) {
        window.clearTimeout(ledgerRebuildTimer)
        ledgerRebuildTimer = undefined
      }
      gapBackfills.clear()
      unhealedGapRanges.clear()
      coveredHistoryRanges.clear()
      rememberedHostOnlyNodes.clear()
    },
  }
}
