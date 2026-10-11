import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  readConversationLayout,
  rememberConversationLayout,
  type ConversationLayout,
} from './conversation-layout.js'

interface LayoutPreference {
  readonly layout: ConversationLayout
  readonly setLayout: (layout: ConversationLayout) => void
  readonly beforeChange: (listener: (layout: ConversationLayout) => void) => () => void
}
const LayoutContext = createContext<LayoutPreference | undefined>(undefined)

export function ConversationLayoutProvider(props: {
  readonly children: ReactNode
  readonly initialLayout?: ConversationLayout
}): ReactElement {
  const [layout, updateLayout] = useState(() => props.initialLayout ?? readConversationLayout())
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const root = document.documentElement
    const previous = root.dataset.dshConversationLayout
    // Portalled dialogs live outside App's main element but share its layout.
    root.dataset.dshConversationLayout = layout
    return () => {
      if (previous === undefined) delete root.dataset.dshConversationLayout
      else root.dataset.dshConversationLayout = previous
    }
  }, [layout])
  const listeners = useRef(new Set<(layout: ConversationLayout) => void>())
  const beforeChange = useCallback((listener: (layout: ConversationLayout) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])
  const setLayout = useCallback((next: ConversationLayout): void => {
    for (const listener of listeners.current) listener(next)
    rememberConversationLayout(next)
    updateLayout(next)
  }, [])
  const value = useMemo(() => ({ layout, setLayout, beforeChange }), [layout, setLayout, beforeChange])
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>
}

/** Standalone legacy consumers retain their existing presentation. */
export function useConversationLayout(): LayoutPreference | undefined {
  return useContext(LayoutContext)
}
