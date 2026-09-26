import { useCallback, useLayoutEffect, useRef } from 'react'

/** Keep host-backed child actions stable while still reading current App state. */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const callbackRef = useRef(callback)
  useLayoutEffect(() => {
    callbackRef.current = callback
  }, [callback])
  return useCallback((...args: Args): Result => callbackRef.current(...args), [])
}
