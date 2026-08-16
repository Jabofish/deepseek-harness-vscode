import type { BackendState, ModelDescriptor, ModelProvider, SessionSummary } from '@dsh-vscode/domain'
import type { TimelineState } from '@dsh-vscode/timeline'
import { unimplemented } from '@dsh-vscode/domain'

export interface AppState {
  readonly backend: BackendState
  readonly sessions: readonly SessionSummary[]
  readonly activeSessionId: string | undefined
  readonly timeline: TimelineState
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly drawer: 'sessions' | 'jobs' | 'subagents' | 'settings' | undefined
}

export interface AppActions {
  initialize(): Promise<void>
  openSession(sessionId: string): Promise<void>
  setDrawer(drawer: AppState['drawer']): void
}

export type AppStore = AppState & AppActions

export function createAppStore(): unknown {
  return unimplemented<unknown>('create Zustand application store', [
    'separate immutable server snapshots from local ephemeral UI state',
    'send all effects through the protocol client, never fetch DSH directly',
    'reduce sequenced backend events through the timeline package',
    'batch message deltas at animation-frame cadence',
    'expose narrow selectors so streaming does not rerender the whole view',
    'clear connection-scoped caches after disconnect',
  ])
}
