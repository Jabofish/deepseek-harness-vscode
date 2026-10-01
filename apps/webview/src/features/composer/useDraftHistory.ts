import { useEffect, useRef } from 'react'

/**
 * Composer draft undo/redo. The stack tracks one entry per accepted edit and
 * is capped, so a long typing session cannot grow it without bound.
 */
export function useDraftHistory(
  draft: string,
  onDraftChange: (value: string) => void,
): {
  readonly restoreDraft: (direction: 'undo' | 'redo') => void
} {
  const historyRef = useRef<{ past: string[]; future: string[]; last: string; skip: boolean }>({
    past: [draft],
    future: [],
    last: draft,
    skip: false,
  })
  useEffect(() => {
    const history = historyRef.current
    if (history.last === draft) {
      // A programmatic restore syncs `last` to the restored value before the
      // change lands, so the effect sees an unchanged draft here. Its skip
      // marker still has to be consumed: leaving it set would swallow the
      // next real edit and keep a stale redo branch alive behind it.
      history.skip = false
      return
    }
    history.last = draft
    if (history.skip) {
      history.skip = false
      return
    }
    history.past.push(draft)
    if (history.past.length > 100) history.past.shift()
    history.future = []
  }, [draft])
  const restoreDraft = (direction: 'undo' | 'redo'): void => {
    const history = historyRef.current
    if (direction === 'undo') {
      if (history.past.length <= 1) return
      const current = history.past.pop()
      if (current === undefined) return
      history.future.unshift(current)
      const previous = history.past[history.past.length - 1]
      if (previous === undefined) return
      history.skip = true
      history.last = previous
      onDraftChange(previous)
      return
    }
    const next = history.future.shift()
    if (next === undefined) return
    history.past.push(next)
    history.skip = true
    history.last = next
    onDraftChange(next)
  }
  return { restoreDraft }
}
