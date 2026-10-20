import { useMemo, useSyncExternalStore, type SetStateAction } from 'react'

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
 * Text belongs to the conversation that owns the composer. Switching
 * conversations stores the outgoing text under that owner and restores the
 * incoming conversation's own draft, so typing in one chat can never be sent
 * from another. A pending composition has no conversation to return to, so
 * its text follows into the session it opens.
 *
 * This is a Webview singleton: `resetDraft` runs when App mounts so a remount
 * (error-boundary recovery, a test render) starts from an empty draft instead
 * of inheriting whatever the previous mount left behind.
 */

export interface DraftStore {
  readonly get: () => string
  readonly set: (action: SetStateAction<string>) => void
  readonly subscribe: (listener: () => void) => () => void
  readonly activate: (owner: string | undefined) => void
  readonly getFor: (owner: string | undefined) => string
  readonly setFor: (owner: string | undefined, action: SetStateAction<string>) => void
  readonly clearIf: (owner: string | undefined, text: string) => void
  readonly reset: () => void
}

const UNSCOPED_OWNER = ''

function createDraftStore(): DraftStore {
  let activeOwner: string | undefined
  let current = ''
  const drafts = new Map<string, string>()
  /** Pending owners whose text moved to the session they opened. */
  const carried = new Map<string, string>()
  const listeners = new Set<() => void>()
  const keyFor = (owner: string | undefined): string => owner ?? UNSCOPED_OWNER
  const resolve = (owner: string | undefined): string => {
    let key = keyFor(owner)
    const seen = new Set<string>()
    while (!seen.has(key)) {
      seen.add(key)
      const next = carried.get(key)
      if (next === undefined) break
      key = next
    }
    return key
  }
  const announce = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    get: () => current,
    set: (action) => {
      const next = typeof action === 'function' ? action(current) : action
      if (next === current) return
      current = next
      const key = keyFor(activeOwner)
      if (next === '') drafts.delete(key)
      else drafts.set(key, next)
      announce()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getFor: (owner) => {
      if (owner === undefined || owner === activeOwner) return current
      return drafts.get(keyFor(owner)) ?? ''
    },
    setFor: (owner, action) => {
      const target = owner === undefined ? activeOwner : owner
      const key = keyFor(target)
      const base = target === activeOwner ? current : (drafts.get(key) ?? '')
      const next = typeof action === 'function' ? action(base) : action
      if (next === base) return
      if (next === '') drafts.delete(key)
      else drafts.set(key, next)
      if (target === activeOwner) current = next
      announce()
    },
    activate: (owner) => {
      if (owner === activeOwner) return
      const previous = activeOwner
      activeOwner = owner
      // The new-session composition is replaced by the session it opens; keep
      // its text with the visible composer until that send settles.
      if (previous?.startsWith('pending:') === true) {
        const text = drafts.get(previous)
        const destination = keyFor(owner)
        if (text !== undefined && text !== '' && !drafts.has(destination)) {
          drafts.delete(previous)
          carried.set(previous, destination)
          drafts.set(destination, text)
        }
      }
      const next = drafts.get(keyFor(owner)) ?? ''
      if (next === current) return
      current = next
      announce()
    },
    clearIf: (owner, text) => {
      const key = resolve(owner)
      const stored = key === keyFor(activeOwner) ? current : (drafts.get(key) ?? '')
      if (stored !== text) return
      if (key === keyFor(activeOwner)) {
        current = ''
        drafts.delete(key)
        announce()
      } else drafts.delete(key)
    },
    reset: () => {
      drafts.clear()
      carried.clear()
      if (current === '') return
      current = ''
      announce()
    },
  }
}

const store = createDraftStore()

/** Subscribe to one composer's draft; reads that owner directly, not whichever is active. */
export function useDraftValue(owner?: string): string {
  const get = useMemo(() => () => store.getFor(owner), [owner])
  return useSyncExternalStore(store.subscribe, get, get)
}

export function setDraft(action: SetStateAction<string>): void {
  store.set(action)
}

/** Edit one composer's draft without depending on activation order. */
export function setDraftFor(owner: string | undefined, action: SetStateAction<string>): void {
  store.setFor(owner, action)
}

/** Event-time read; render-time consumers must use `useDraftValue`. */
export function readDraft(): string {
  return store.get()
}

/** Point edits and reads at the conversation currently shown in the composer. */
export function activateDraftOwner(owner: string | undefined): void {
  store.activate(owner)
}

/** Drop the submitted text only while it still matches, even after a switch. */
export function clearDraftIf(owner: string | undefined, text: string): void {
  store.clearIf(owner, text)
}

export function resetDraft(): void {
  store.reset()
}
