import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLoopLagMonitor } from './event-loop-lag.js'

describe('EventLoopLagMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('includes an overdue tick before the sampler can run', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor({ intervalMs: 100, now: () => now })
    try {
      monitor.start()
      // A connection-lost microtask can run before the delayed timer callback.
      now = 3_000
      expect(monitor.recentMaxLagMs()).toBe(2_900)
      now += 100
      expect(monitor.recentMaxLagMs()).toBe(3_000)
      vi.advanceTimersByTime(100)
      expect(monitor.recentMaxLagMs()).toBe(3_000)
    } finally {
      monitor.dispose()
    }
  })
})
