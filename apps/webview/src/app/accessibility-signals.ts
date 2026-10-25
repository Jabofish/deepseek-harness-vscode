import { useSyncExternalStore } from 'react'

interface AccessibilitySignals {
  readonly reducedMotion: boolean
  readonly screenReader: boolean
}

const listeners = new Set<() => void>()
let snapshot: AccessibilitySignals = { reducedMotion: false, screenReader: false }
let published = snapshot
let media: MediaQueryList | undefined
let dispose: (() => void) | undefined

/** One subscription owner per Webview, shared by React and imperative motion. */
export function getAccessibilitySignals(): AccessibilitySignals {
  const reducedMotion =
    (
      media ??
      (typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined)
    )?.matches === true || document.body.classList.contains('vscode-reduce-motion')
  const screenReader = document.body.classList.contains('vscode-using-screen-reader')
  if (snapshot.reducedMotion !== reducedMotion || snapshot.screenReader !== screenReader)
    snapshot = { reducedMotion, screenReader }
  return snapshot
}

export function subscribeAccessibilitySignals(listener: () => void): () => void {
  listeners.add(listener)
  if (dispose === undefined) {
    media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : undefined
    const changed = (): void => {
      if (getAccessibilitySignals() === published) return
      published = snapshot
      for (const notify of listeners) notify()
    }
    const observer = new MutationObserver(changed)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    media?.addEventListener('change', changed)
    published = getAccessibilitySignals()
    dispose = () => {
      observer.disconnect()
      media?.removeEventListener('change', changed)
      media = undefined
    }
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size !== 0) return
    dispose?.()
    dispose = undefined
  }
}

export function useAccessibilitySignals(): AccessibilitySignals {
  return useSyncExternalStore(subscribeAccessibilitySignals, getAccessibilitySignals)
}
