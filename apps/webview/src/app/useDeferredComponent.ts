import { useCallback, useEffect, useState, type ComponentType } from 'react'

type Snapshot<Props> = { readonly Component: ComponentType<Props> } | { readonly failed: true }

/** Load at first intent, retain the mounted view afterward, and ignore abandoned reads. */
export function useDeferredComponent<Props>(
  active: boolean,
  load: () => Promise<ComponentType<Props>>,
): {
  readonly Component: ComponentType<Props> | undefined
  readonly failed: boolean
  readonly retry: () => void
} {
  const [snapshot, setSnapshot] = useState<Snapshot<Props> | undefined>(undefined)
  useEffect(() => {
    if (!active || snapshot !== undefined) return
    let current = true
    void Promise.resolve()
      .then(load)
      .then((Component) => {
        if (current) setSnapshot({ Component })
      })
      .catch(() => {
        if (current) setSnapshot({ failed: true })
      })
    return () => {
      current = false
    }
  }, [active, load, snapshot])
  const retry = useCallback((): void => setSnapshot(undefined), [])
  return {
    Component: snapshot !== undefined && 'Component' in snapshot ? snapshot.Component : undefined,
    failed: snapshot !== undefined && 'failed' in snapshot,
    retry,
  }
}
