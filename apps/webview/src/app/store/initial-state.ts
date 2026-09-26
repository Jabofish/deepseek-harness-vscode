import type { ModelSelection, PromptMode, SubagentCatalog } from '@dsh-vscode/domain'
import type { AppState } from './types.js'

export interface ComposerPreferences {
  readonly model?: ModelSelection
  readonly openFileId?: string
  readonly promptMode?: PromptMode
}

export interface PersistedWebviewState {
  readonly version: 1
  readonly composerPreferences?: ComposerPreferences
  readonly activeSessionId?: string
}

export const EMPTY_SUBAGENT_CATALOG: SubagentCatalog = { entries: [], parentAvailable: false }

export function createInitialState(composerPreferences: ComposerPreferences): AppState {
  return {
    backend: { kind: 'idle' },
    connectionEpoch: 0,
    connectedDshVersion: undefined,
    subagentImagePrompts: false,
    sessionRestore: false,
    jobControllerAvailable: false,
    dshCompatibilityWarning: undefined,
    dshUpdate: undefined,
    dshUpdateProgress: undefined,
    sessions: [],
    sessionDirectoryStatus: 'loading',
    archivedSessionIds: [],
    archivedSessions: [],
    workspaces: [],
    activeSessionId: undefined,
    pendingSession: undefined,
    preferredOpenFileId: composerPreferences.openFileId,
    timeline: { sessionId: undefined, nodes: [], lastSequence: -1, nodeChangeStart: 0, eventCount: 0 },
    history: [],
    historyHasMore: false,
    historyBeforeSequence: undefined,
    historyLoading: false,
    projections: {},
    configuration: undefined,
    providers: [],
    models: [],
    sessionModels: [],
    sessionModelFailures: [],
    sessionModelCurrent: undefined,
    sessionModelRoutable: undefined,
    sessionModelDirectoryLoading: false,
    sessionModelDirectoryError: undefined,
    presets: [],
    presetSelectionEnabled: undefined,
    permissionPresets: [],
    commands: [],
    pluginInventoryRevision: 0,
    pluginInstallProgress: undefined,
    pluginInstallOperation: undefined,
    accountLifecycleAvailable: false,
    accountLifecycle: null,
    accountLifecycleLoading: false,
    accountLifecycleBusy: false,
    accountLifecycleImpact: undefined,
    accountSessionExpired: false,
    accountLifecycleError: undefined,
    accountLifecycleRequestFailed: false,
    accountProfileDetails: null,
    accountProfileLoading: false,
    accountProfileRequestFailed: false,
    goals: [],
    todos: [],
    jobs: [],
    jobFollow: undefined,
    feedback: {},
    feedbackUnavailable: false,
    subagents: EMPTY_SUBAGENT_CATALOG,
    activeSubagent: undefined,
    queue: [],
    editorContext: [],
    editorContextAvailableKinds: [],
    editorContextLoading: false,
    changes: [],
    changesRefreshFailed: false,
    changesLoading: false,
    tasks: [],
    tasksLoading: false,
    taskScope: 'current-session',
    tasksComplete: true,
    tasksOmittedSessions: 0,
    checkpoints: [],
    unavailableLists: [],
    checkpointsLoading: false,
    promptTemplates: [],
    promptTemplatesLoading: false,
    promptMode: composerPreferences.promptMode ?? 'ask',
    permissions: [],
    questions: [],
    busyEnter: 'queue',
    drawer: undefined,
  }
}
