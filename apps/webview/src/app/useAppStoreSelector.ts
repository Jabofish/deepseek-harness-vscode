import type { StateSubscription } from './store/state-subscriptions.js'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { AppState, AppStore } from './store.js'

export type AppStateSource = Pick<AppStore, 'getState' | 'subscribe'>

/** The external snapshot reader owns its cache for one subscription configuration. */
function createSelectionReader<Selection>(
  store: AppStateSource,
  select: (state: AppState) => Selection,
  isEqual: (previous: Selection, next: Selection) => boolean,
): () => Selection {
  let snapshot: { readonly state: AppState; readonly selection: Selection } | undefined
  return (): Selection => {
    const state = store.getState()
    if (snapshot?.state === state) return snapshot.selection
    const next = select(state)
    const selection = snapshot !== undefined && isEqual(snapshot.selection, next) ? snapshot.selection : next
    snapshot = { state, selection }
    return selection
  }
}

/** Cache a selected snapshot so unrelated store notifications do not render its consumer. */
export function useAppStoreSelector<Selection>(
  store: AppStateSource,
  select: (state: AppState) => Selection,
  isEqual: (previous: Selection, next: Selection) => boolean = Object.is,
  fields?: StateSubscription<AppState>,
): Selection {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener, fields), [store, fields])
  const getSnapshot = useMemo(() => createSelectionReader(store, select, isEqual), [store, select, isEqual])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function sameShallowSelection<Selection extends object>(
  previous: Selection,
  next: Selection,
): boolean {
  if (previous === next) return true
  const keys = Object.keys(previous) as (keyof Selection)[]
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => Object.hasOwn(next, key) && Object.is(previous[key], next[key]))
  )
}
