import type { ModelCatalogFailure, ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'
import type { AppState } from './types.js'

/** Session directory facts remain separate from the user's persisted configuration. */
export interface SessionModelDirectoryState {
  readonly sessionModels: readonly ModelDescriptor[]
  /** Provider enumeration failures remain visible when the global catalog stands in. */
  readonly sessionModelFailures: readonly ModelCatalogFailure[]
  /** Host-stated next route; displaying it must never write it back as a user selection. */
  readonly sessionModelCurrent: ModelSelection | undefined
  /** Host verdict, not a guess from the advertised rows; undefined means no answer yet. */
  readonly sessionModelRoutable: boolean | undefined
  readonly sessionModelDirectoryLoading: boolean
  /** A refused read keeps the last good directory and exposes its reason and retry. */
  readonly sessionModelDirectoryError: string | undefined
}

export interface ComposerModelDirectory {
  readonly models: readonly ModelDescriptor[]
  readonly modelFailures?: readonly ModelCatalogFailure[]
  readonly modelCurrent?: ModelSelection
  readonly modelRoutable?: boolean
  readonly modelLoading?: boolean
  readonly modelError?: string
}

export function selectSessionModels(
  state: Pick<AppState, 'sessionModels' | 'models'>,
): readonly ModelDescriptor[] {
  return state.sessionModels.length > 0 ? state.sessionModels : state.models
}

export function selectSessionComposerModels(state: AppState): ComposerModelDirectory {
  return {
    models: selectSessionModels(state),
    modelFailures: state.sessionModelFailures,
    modelLoading: state.sessionModelDirectoryLoading,
    ...(state.sessionModelCurrent === undefined ? {} : { modelCurrent: state.sessionModelCurrent }),
    ...(state.sessionModelRoutable === undefined ? {} : { modelRoutable: state.sessionModelRoutable }),
    ...(state.sessionModelDirectoryError === undefined
      ? {}
      : { modelError: state.sessionModelDirectoryError }),
  }
}

export function selectGlobalComposerModels(state: AppState): ComposerModelDirectory {
  return { models: state.models }
}
