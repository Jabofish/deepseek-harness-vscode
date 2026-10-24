import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventLoopLagMonitor } from './event-loop-lag.js'

describe('EventLoopLagMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports zero lag while the loop keeps pace with the sampler', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor({ intervalMs: 100, windowMs: 1_000, now: () => now })
    monitor.start()
    for (let tick = 0; tick < 5; tick++) {
      now += 100
      vi.advanceTimersByTime(100)
    }
    expect(monitor.recentMaxLagMs()).toBe(0)
    monitor.dispose()
  })

  it('reports a stall as the trailing maximum lag', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor({ intervalMs: 100, windowMs: 1_000, now: () => now })
    monitor.start()
    now += 100
    vi.advanceTimersByTime(100)
    // The loop then stalls for 3s before the next tick can fire; the tick due
    // at +100ms arrives 2900ms late.
    now += 3_000
    vi.advanceTimersByTime(100)
    expect(monitor.recentMaxLagMs()).toBe(2_900)
    monitor.dispose()
  })

  it('forgets lag samples outside the trailing window', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor({ intervalMs: 100, windowMs: 1_000, now: () => now })
    monitor.start()
    now += 100
    vi.advanceTimersByTime(100)
    now += 3_000
    vi.advanceTimersByTime(100)
    expect(monitor.recentMaxLagMs()).toBe(2_900)
    for (let tick = 0; tick < 12; tick++) {
      now += 100
      vi.advanceTimersByTime(100)
    }
    expect(monitor.recentMaxLagMs()).toBe(0)
    monitor.dispose()
  })

  it('stops sampling after dispose', () => {
    let now = 0
    const monitor = new EventLoopLagMonitor({ intervalMs: 100, windowMs: 1_000, now: () => now })
    monitor.start()
    monitor.dispose()
    now += 3_000
    vi.advanceTimersByTime(100)
    expect(monitor.recentMaxLagMs()).toBe(0)
  })
})
