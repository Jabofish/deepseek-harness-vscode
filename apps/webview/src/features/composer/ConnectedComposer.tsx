import { Composer, type ComposerProps } from './Composer.js'
import { useDraftValue, setDraft } from '../../app/draft-store.js'
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
  const draft = useDraftValue()
  const directory = useAppStoreSelector(
    store,
    modelScope === 'session' ? selectSessionComposerModels : selectGlobalComposerModels,
    sameShallowSelection,
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
      onDraftChange={setDraft}
      {...(modelScope === 'session' ? { onModelRetry: retryModels } : {})}
    />
  )
}
