import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { installTranscript, parseTranscript } from './transcript-state.js'
import type { AppState, StateSetter } from './types.js'

/** The Host prepends older rows; the renderer installs its authoritative window. */
export function createHistoryActions(deps: {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
}): { readonly loadOlderHistory: () => Promise<void> } {
  let generation = 0
  return {
    loadOlderHistory: async () => {
      const state = deps.getState()
      const window = state.transcript
      if (window === undefined || state.historyLoading || !window.hasMore) return
      const requestGeneration = ++generation
      deps.setState((current) => ({ ...current, historyLoading: true }))
      try {
        const next = parseTranscript(
          await deps.client.request<unknown>({
            type: 'session.transcript.navigate',
            requestId: requestId(),
            payload: { sessionId: window.sessionId, revision: window.revision, direction: 'older' },
          }),
        )
        deps.setState((current) => installTranscript(current, next))
      } finally {
        if (requestGeneration === generation)
          deps.setState((current) =>
            current.activeSessionId === window.sessionId ? { ...current, historyLoading: false } : current,
          )
      }
    },
  }
}
