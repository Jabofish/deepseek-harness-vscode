export const STREAM_BATCH_SIZE = 64
export const STREAM_TIME_SLICE_MS = 8

/**
 * Run after the poll phase so ws's deferred Ping/Pong callbacks can progress.
 * Cancellation releases the scheduled turn without waiting for its callback.
 */
export function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = (): void => {
      clearImmediate(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setImmediate(finish)
    signal?.addEventListener('abort', finish, { once: true })
  })
}
