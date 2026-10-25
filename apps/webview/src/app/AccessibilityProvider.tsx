import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import { useAccessibilitySignals } from './accessibility-signals.js'
import {
  readActivityPresentation,
  rememberActivityPresentation,
  type ActivityPresentation,
} from './activity-presentation.js'

interface ActivityPreference {
  readonly presentation: ActivityPresentation
  readonly setPresentation: (value: ActivityPresentation) => void
}
const ActivityContext = createContext<ActivityPreference | undefined>(undefined)

export function AccessibilityProvider(props: { readonly children: ReactNode }): ReactElement {
  const [presentation, setPresentation] = useState(readActivityPresentation)
  const value = useMemo(
    () => ({
      presentation,
      setPresentation: (next: ActivityPresentation): void => {
        rememberActivityPresentation(next)
        setPresentation(next)
      },
    }),
    [presentation],
  )
  return <ActivityContext.Provider value={value}>{props.children}</ActivityContext.Provider>
}

export function useActivityPreference(): ActivityPreference | undefined {
  return useContext(ActivityContext)
}

/** Standalone surfaces still honor the host's screen-reader signal. */
export function useQuietActivity(): boolean {
  const { screenReader } = useAccessibilitySignals()
  const preference = useActivityPreference()?.presentation ?? 'auto'
  return preference === 'quiet' || (preference === 'auto' && screenReader)
}
