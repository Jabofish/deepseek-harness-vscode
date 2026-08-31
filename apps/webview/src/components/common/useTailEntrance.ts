import { useLayoutEffect, useReducer } from 'react'

interface TailEntranceState {
  readonly resetKey: string | number | undefined
  readonly tailId: string | undefined
  readonly primed: boolean
  readonly enteredId: string | undefined
}

type TailEntranceAction = {
  readonly type: 'sync'
  readonly resetKey: string | number | undefined
  readonly tailId: string | undefined
  readonly suppress: boolean
}

/**
 * Identifies only a newly appended tail node for a lightweight entrance.
 * Initial paints, session switches, and prepends keep a stable baseline and
 * therefore never animate a virtualized history window.
 */
export function useTailEntrance(
  tailId: string | undefined,
  resetKey: string | number | undefined,
  suppress = false,
): string | undefined {
  const [state, dispatch] = useReducer(tailEntranceReducer, {
    resetKey,
    tailId,
    primed: false,
    enteredId: undefined,
  })

  useLayoutEffect(() => {
    // A layout effect applies the class before the browser paints the new
    // row. The old effect applied it after the first paint and removed it on
    // the next frame, which made a streamed update flash from visible to
    // transparent and back again before the 120/180ms CSS animation finished.
    dispatch({ type: 'sync', resetKey, tailId, suppress })
  }, [resetKey, suppress, tailId])

  return state.enteredId
}

function tailEntranceReducer(state: TailEntranceState, action: TailEntranceAction): TailEntranceState {
  if (action.resetKey !== state.resetKey) {
    return {
      resetKey: action.resetKey,
      tailId: action.tailId,
      primed: true,
      enteredId: undefined,
    }
  }
  if (!state.primed) return { ...state, tailId: action.tailId, primed: true, enteredId: undefined }
  if (action.tailId === undefined)
    return state.enteredId === undefined && state.tailId === undefined
      ? state
      : { ...state, tailId: undefined, enteredId: undefined }
  if (action.suppress)
    return state.tailId === action.tailId && state.enteredId === undefined
      ? state
      : { ...state, tailId: action.tailId, enteredId: undefined }
  if (state.tailId === action.tailId) return state
  // Keep the class mounted until another tail arrives. Removing it on the
  // next animation frame cancels the CSS animation and is observable as a
  // flash. The completed animation is visually inert, while the next tail
  // naturally moves the class to the new row.
  return { ...state, tailId: action.tailId, enteredId: action.tailId }
}
