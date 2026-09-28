import type { SessionHistoryPage, SessionRepository } from '@dsh-vscode/domain'
import type { StreamRecovery } from '../../stream-controller.js'
import { walkHistoryPages } from '../shared/guards.js'

/**
 * Build the stream gap-recovery callback the version adapters share. The
 * pinned hosts page `session.history` at 50 events, so a reconnect gap wider
 * than the newest page must walk backward through history pages from the gap
 * end until a page reaches the gap start. The stream controller announces any
 * remainder (history evicted or truncated host-side) as an explicit
 * `session.gap`, so consumers never mistake an incomplete replay for a
 * contiguous stream — but a page-bounded read would turn every wide
 * reconnect into one of those gaps even though the events are readable.
 */
interface HistoryRecoverySource extends Pick<SessionRepository, 'history'> {
  readonly historyForRecovery?: (
    sessionId: string,
    beforeSequence?: number,
    signal?: AbortSignal,
  ) => Promise<SessionHistoryPage>
}

export function historyGapRecovery(sessions: HistoryRecoverySource): StreamRecovery {
  const history = sessions.historyForRecovery ?? sessions.history
  return async (sessionId, fromSequence, toSequence, signal) => {
    const pages = await walkHistoryPages(
      (beforeSequence) => history.call(sessions, sessionId, beforeSequence, signal),
      {
        initialBeforeSequence: toSequence + 1,
        stopWhen: (page) => {
          const sequences = page.events
            .map((entry) => entry.sequence)
            .filter((value) => Number.isSafeInteger(value) && value >= 0)
          const oldest = sequences.length === 0 ? undefined : Math.min(...sequences)
          return oldest !== undefined && oldest <= fromSequence
        },
      },
    )
    return pages
      .flatMap((page) => page.events)
      .filter((entry) => entry.sequence >= fromSequence && entry.sequence <= toSequence)
      .map((entry) => entry.event)
  }
}
