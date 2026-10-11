export interface RetryDelays {
  readonly wait: (milliseconds: number) => Promise<boolean>
  readonly dispose: () => void
}

/** Disposal clears every owned backoff and wakes its waiter without another attempt. */
export function createRetryDelays(): RetryDelays {
  let disposed = false
  const pending = new Map<number, (elapsed: boolean) => void>()
  return {
    wait: (milliseconds) => {
      if (disposed) return Promise.resolve(false)
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          pending.delete(timer)
          resolve(true)
        }, milliseconds)
        pending.set(timer, resolve)
      })
    },
    dispose: () => {
      disposed = true
      for (const [timer, resolve] of pending) {
        window.clearTimeout(timer)
        resolve(false)
      }
      pending.clear()
    },
  }
}
