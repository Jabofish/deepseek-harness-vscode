import type { AppState } from './types.js'
import type { SessionModelDirectoryState } from './model-directory-state.js'

/** The page shell does not own the model picker's directory or read lifecycle. */
export type AppViewState = Omit<AppState, keyof SessionModelDirectoryState>

export function selectAppViewState({
  sessionModels: _sessionModels,
  sessionModelFailures: _sessionModelFailures,
  sessionModelCurrent: _sessionModelCurrent,
  sessionModelRoutable: _sessionModelRoutable,
  sessionModelDirectoryLoading: _sessionModelDirectoryLoading,
  sessionModelDirectoryError: _sessionModelDirectoryError,
  ...state
}: AppState): AppViewState {
  return state
}

export const APP_VIEW_SUBSCRIPTION = {
  exclude: [
    'sessionModels',
    'sessionModelFailures',
    'sessionModelCurrent',
    'sessionModelRoutable',
    'sessionModelDirectoryLoading',
    'sessionModelDirectoryError',
  ],
} as const
