import { transcriptWindowSchema, type TranscriptWindow } from '@dsh-vscode/webview-protocol'
import type { TimelineState } from '@dsh-vscode/timeline'
import type { AppState } from './types.js'
import { withCurrentTodos } from './todo-state.js'

export function parseTranscript(value: unknown): TranscriptWindow {
  return transcriptWindowSchema.parse(value) as TranscriptWindow
}

export function transcriptTimeline(window: TranscriptWindow): TimelineState {
  return {
    sessionId: window.sessionId,
    nodes: window.nodes,
    lastSequence: window.lastSequence,
    nodeChangeStart: 0,
    eventCount: window.nodes.filter((node) => node.kind === 'event').length,
    ...(window.tokenUsage === undefined ? {} : { tokenUsage: window.tokenUsage }),
    ...(window.activeTurn === undefined ? {} : { activeTurn: window.activeTurn }),
  }
}

export function installTranscript(state: AppState, window: TranscriptWindow): AppState {
  if (
    window.sessionId !== state.activeSessionId ||
    (state.transcript !== undefined && window.revision <= state.transcript.revision)
  )
    return state
  return withCurrentTodos({
    ...state,
    transcript: window,
    timeline: transcriptTimeline(window),
    historyHasMore: window.hasMore,
    historyBeforeSequence: window.beforeSequence,
    historyLoading: false,
  })
}
