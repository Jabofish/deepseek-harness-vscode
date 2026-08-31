import { useEffect, useReducer } from 'react'

interface TailEntranceState {
  readonly resetKey: string | number | undefined
  readonly tailId: string | undefined
  readonly primed: boolean
  readonly enteredId: string | undefined
}

type TailEntranceAction =
  | {
      readonly type: 'sync'
      readonly resetKey: string | number | undefined
      readonly tailId: string | undefined
    }
  | { readonly type: 'clear'; readonly id: string }

/**
 * Identifies only a newly appended tail node for a lightweight entrance.
 * Initial paints, session switches, and prepends keep a stable baseline and
 * therefore never animate a virtualized history window.
 */
export function useTailEntrance(
  tailId: string | undefined,
  resetKey: string | number | undefined,
): string | undefined {
  const [state, dispatch] = useReducer(tailEntranceReducer, {
    resetKey,
    tailId,
    primed: false,
    enteredId: undefined,
  })

  useEffect(() => {
    dispatch({ type: 'sync', resetKey, tailId })
  }, [resetKey, tailId])

  useEffect(() => {
    const enteredId = state.enteredId
    if (enteredId === undefined) return
    const clear = (): void => dispatch({ type: 'clear', id: enteredId })
    if (typeof window.requestAnimationFrame !== 'function') {
      const timer = window.setTimeout(clear, 0)
      return () => window.clearTimeout(timer)
    }
    const frame = window.requestAnimationFrame(clear)
    return () => window.cancelAnimationFrame(frame)
  }, [state.enteredId])

  return state.enteredId
}

function tailEntranceReducer(state: TailEntranceState, action: TailEntranceAction): TailEntranceState {
  if (action.type === 'clear') {
    return state.enteredId === action.id ? { ...state, enteredId: undefined } : state
  }

  if (action.resetKey !== state.resetKey) {
    return {
      resetKey: action.resetKey,
      tailId: action.tailId,
      primed: true,
      enteredId: undefined,
    }
  }
  if (!state.primed) return { ...state, tailId: action.tailId, primed: true, enteredId: undefined }
  if (state.tailId === action.tailId || action.tailId === undefined) {
    return state.enteredId === undefined ? state : { ...state, enteredId: undefined }
  }
  return { ...state, tailId: action.tailId, enteredId: action.tailId }
}
