import type { AppStore, AppState } from './types.js'

export const STATE_VIEW_KEYS_A = ['backend', 'connectedDshVersion'] as const

export const STATE_VIEW_KEYS_B = [
  'subagentImagePrompts',
  'dshCompatibilityWarning',
  'dshUpdate',
  'dshUpdateProgress',
  'sessions',
  'archivedSessionIds',
  'archivedSessions',
  'workspaces',
  'activeSessionId',
  'pendingSession',
  'preferredOpenFileId',
  'timeline',
  'history',
  'historyHasMore',
  'historyBeforeSequence',
  'historyLoading',
  'projections',
  'configuration',
  'providers',
  'models',
  'sessionModels',
  'sessionModelFailures',
  'sessionModelCurrent',
  'sessionModelRoutable',
  'sessionModelDirectoryLoading',
  'sessionModelDirectoryError',
  'presets',
  'presetSelectionEnabled',
  'permissionPresets',
  'commands',
  'pluginInventoryRevision',
  'pluginInstallProgress',
  'pluginInstallOperation',
  'accountLifecycleAvailable',
  'accountLifecycle',
  'accountLifecycleLoading',
  'accountLifecycleBusy',
  'accountLifecycleImpact',
  'accountSessionExpired',
  'accountLifecycleError',
  'accountLifecycleRequestFailed',
  'accountProfileDetails',
  'accountProfileLoading',
  'accountProfileRequestFailed',
  'goals',
  'todos',
  'jobs',
  'jobControllerAvailable',
  'jobFollow',
  'feedback',
] as const

export const STATE_VIEW_KEYS_C = [
  'subagents',
  'activeSubagent',
  'queue',
  'editorContext',
  'editorContextAvailableKinds',
  'editorContextLoading',
  'changes',
  'changesRefreshFailed',
  'changesLoading',
  'tasks',
  'tasksLoading',
  'taskScope',
  'tasksComplete',
  'tasksOmittedSessions',
  'checkpoints',
] as const

export const STATE_VIEW_KEYS_D = [
  'checkpointsLoading',
  'promptTemplates',
  'promptTemplatesLoading',
  'promptMode',
  'permissions',
  'questions',
  'busyEnter',
  'drawer',
] as const

export const STATE_VIEW_KEYS = [
  ...STATE_VIEW_KEYS_A,
  ...STATE_VIEW_KEYS_B,
  ...STATE_VIEW_KEYS_C,
  ...STATE_VIEW_KEYS_D,
] as const

/**
 * The store's public surface mirrors most AppState fields as readonly
 * accessors so React subscribers always read the live value, and three fields
 * carry a small derivation (boolean coercion or list default). The accessor
 * bodies are mechanical: defineStateView installs them on the assembled store
 * object, and the key lists keep the set explicit and type-checked against
 * AppState.
 */
export type StoreWithoutStateView = Omit<AppStore, (typeof STATE_VIEW_KEYS)[number]>

export function defineStateView(store: StoreWithoutStateView, getState: () => AppState): AppStore {
  for (const key of STATE_VIEW_KEYS) {
    Object.defineProperty(store, key, {
      enumerable: true,
      configurable: true,
      get: () => getState()[key],
    })
  }
  return store as AppStore
}
