/** Shared poll recovery: a short stall must not silently end the user's grant. */
export const POLL_ATTEMPTS = 6
const BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000] as const

export function retryDelay(attempt: number): number {
  return BACKOFF_MS[attempt - 1] ?? 4_000
}

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener('abort', done, { once: true })
  })
}
