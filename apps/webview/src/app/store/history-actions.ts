import { translate } from '../../i18n.js'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import type { createGapHealing } from './gap-heal.js'
import {
  historyPageCoverage,
  hydrateTimelineFromHistoryEvents,
  mergeLiveTransientNodes,
  parseSessionHistoryPage,
} from './history-replay.js'
import { mergeHistory, newestHistorySequence, oldestHistorySequence } from './history-ledger.js'
import { latestTodos } from './host-message-reducers.js'
import { parseSubagentHistory } from './subagent.js'
import type { AppState, StateSetter } from './types.js'
import { setSessionProjection, type ProjectionSequenceIndex } from './session-projection.js'

type GapHealingOperations = ReturnType<typeof createGapHealing>

export interface HistoryActionDependencies {
  readonly client: ProtocolClient
  readonly flushPendingHistory: () => void
  readonly getOpenVersion: () => number
  readonly getState: () => AppState
  readonly projectionSequences: ProjectionSequenceIndex
  readonly rememberCoveredRanges: GapHealingOperations['rememberCoveredRanges']
  readonly restoreGapNotices: GapHealingOperations['restoreGapNotices']
  readonly restoreHostOnlyNodes: GapHealingOperations['restoreHostOnlyNodes']
  readonly setState: StateSetter
}

export function createHistoryActions(deps: HistoryActionDependencies): {
  readonly loadOlderHistory: () => Promise<void>
} {
  const {
    client,
    flushPendingHistory,
    getOpenVersion,
    getState,
    projectionSequences,
    rememberCoveredRanges,
    restoreGapNotices,
    restoreHostOnlyNodes,
    setState,
  } = deps

  // The loading flag is shared by every session, so one pagination request may
  // be in flight at a time. Ownership of that flag is not the open barrier: a
  // failed navigation advances the open version without ever taking the flag
  // over, and only a newer load may release a newer load's flag. Keying the
  // release on the open barrier instead strands the flag on the session the
  // user is still reading and permanently disables its older-page paging.
  let loadGeneration = 0

  const loadOlderHistory = async (): Promise<void> => {
    flushPendingHistory()
    const state = getState()
    const sessionId = state.activeSessionId
    const beforeSeq = state.historyBeforeSequence
    // A child transcript pages through `subagent.history`: its records live in
    // the parent's subagent log, so `session.history` would answer for the
    // wrong log.
    const childTranscript = state.activeSubagent !== undefined
    if (sessionId === undefined || !state.historyHasMore || beforeSeq === undefined || state.historyLoading)
      return
    const version = getOpenVersion()
    const generation = ++loadGeneration
    setState((current) =>
      current.activeSessionId === sessionId ? { ...current, historyLoading: true } : current,
    )
    try {
      const result = await client.request<unknown>(
        childTranscript
          ? {
              type: 'subagent.history',
              requestId: requestId(),
              payload: { sessionId, beforeSeq, maxMessages: 200 },
            }
          : {
              type: 'session.history',
              requestId: requestId(),
              payload: { sessionId, beforeSeq, maxMessages: 200, pagePurpose: 'transcript' },
            },
      )
      const page = childTranscript ? parseSubagentHistory(result) : parseSessionHistoryPage(result)
      // Remember the raw window before the merge gate: a page that cannot be
      // merged (another open superseded this one, a discontinuous cursor) still
      // proves which sequences upstream has, which is what clears a warning.
      rememberCoveredRanges(sessionId, historyPageCoverage(page))
      // A live stream can publish while the paging request is in flight.
      // Flush the coalesced history ledger before taking the functional
      // update so the page is merged with the newest state, not the state
      // that existed when the request started.
      flushPendingHistory()
      let discontinuous = false
      setState((next) => {
        if (version !== getOpenVersion() || next.activeSessionId !== sessionId) return next
        const currentBase = next.historyBeforeSequence ?? oldestHistorySequence(next.history)
        const pageNewest = newestHistorySequence(page.events)
        if (pageNewest !== undefined && currentBase !== undefined && pageNewest >= currentBase) {
          discontinuous = true
          return { ...next, historyLoading: false }
        }
        const history = mergeHistory(next.history, page.events)
        const timeline = mergeLiveTransientNodes(
          restoreHostOnlyNodes(
            restoreGapNotices(hydrateTimelineFromHistoryEvents(sessionId, history), sessionId, history),
            sessionId,
          ),
          next.timeline,
          history,
        )
        const nextBefore = page.beforeSequence ?? oldestHistorySequence(page.events)
        const hasMore =
          page.hasMore && nextBefore !== undefined && (currentBase === undefined || nextBefore < currentBase)
        return {
          ...next,
          timeline,
          history,
          historyHasMore: hasMore,
          historyBeforeSequence: nextBefore,
          historyLoading: false,
          projections:
            page.projection === undefined
              ? next.projections
              : setSessionProjection(next.projections, sessionId, page.projection, projectionSequences),
          todos: latestTodos(timeline),
        }
      })
      if (discontinuous) throw new Error(translate('app.error.historyDiscontinuous'))
    } finally {
      const current = getState()
      if (generation === loadGeneration && current.activeSessionId === sessionId && current.historyLoading)
        setState((state) =>
          state.activeSessionId === sessionId ? { ...state, historyLoading: false } : state,
        )
    }
  }

  return { loadOlderHistory }
}
