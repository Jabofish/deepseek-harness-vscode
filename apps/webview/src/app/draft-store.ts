import { useSyncExternalStore, type SetStateAction } from 'react'

/**
 * The composer draft, held outside the React tree so two composer instances
 * (new-session draft and open conversation) share one text while drawers
 * (prompt templates, new-session actions) can rewrite it.
 *
 * The store is deliberately NOT App state: a keystroke would otherwise
 * re-render the entire application. The value is subscribed to by the
 * composer binding alone; App and submit logic access it imperatively through
 * the module functions, which never change identity.
 *
 * This is a Webview singleton: `resetDraft` runs when App mounts so a remount
 * (error-boundary recovery, a test render) starts from an empty draft instead
 * of inheriting whatever the previous mount left behind.
 */

export interface DraftStore {
  readonly get: () => string
  readonly set: (action: SetStateAction<string>) => void
  readonly subscribe: (listener: () => void) => () => void
}

function createDraftStore(): DraftStore {
  let current = ''
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (action) => {
      const next = typeof action === 'function' ? action(current) : action
      if (next === current) return
      current = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const store = createDraftStore()

export function useDraftValue(): string {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export function setDraft(action: SetStateAction<string>): void {
  store.set(action)
}

/** Event-time read; render-time consumers must use `useDraftValue`. */
export function readDraft(): string {
  return store.get()
}

export function resetDraft(): void {
  store.set('')
}
