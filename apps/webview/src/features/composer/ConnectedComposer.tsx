import { Composer, type ComposerProps } from './Composer.js'
import { useDraftValue, setDraftFor } from '../../app/draft-store.js'
import { useCallback, type ReactElement } from 'react'
import type { AppStore } from '../../app/store.js'
import {
  sameShallowSelection,
  useAppStoreSelector,
  type AppStateSource,
} from '../../app/useAppStoreSelector.js'
import {
  selectGlobalComposerModels,
  selectSessionComposerModels,
  type ComposerModelDirectory,
} from '../../app/store/model-directory-state.js'

type ConnectedComposerProps = Omit<
  ComposerProps,
  'draft' | 'onDraftChange' | 'onModelRetry' | keyof ComposerModelDirectory
> & {
  readonly store: AppStateSource & Pick<AppStore, 'refreshSessionModels'>
  readonly modelScope: 'global' | 'session'
}

/**
 * Draft edits and model directory reads subscribe here, keeping their render
 * lifecycle inside the composer rather than the page shell.
 */
export function ConnectedComposer({ store, modelScope, ...props }: ConnectedComposerProps): ReactElement {
  const draft = useDraftValue(props.draftKey)
  const directory = useAppStoreSelector(
    store,
    modelScope === 'session' ? selectSessionComposerModels : selectGlobalComposerModels,
    sameShallowSelection,
    modelScope === 'session' ? SESSION_MODEL_FIELDS : GLOBAL_MODEL_FIELDS,
  )
  const changeDraft = useCallback(
    (value: string | ((current: string) => string)) => setDraftFor(props.draftKey, value),
    [props.draftKey],
  )
  const retryModels = useCallback((): void => {
    // The picker already states the failure; a second page banner would repeat it.
    void store.refreshSessionModels().catch(() => undefined)
  }, [store])
  return (
    <Composer
      {...props}
      {...directory}
      draft={draft}
      onDraftChange={changeDraft}
      {...(modelScope === 'session' ? { onModelRetry: retryModels } : {})}
    />
  )
}

const GLOBAL_MODEL_FIELDS = ['models'] as const
const SESSION_MODEL_FIELDS = [
  'models',
  'sessionModels',
  'sessionModelFailures',
  'sessionModelDirectoryLoading',
  'sessionModelCurrent',
  'sessionModelRoutable',
  'sessionModelDirectoryError',
] as const
