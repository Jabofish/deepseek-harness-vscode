import { describe, expect, it } from 'vitest'
import { BoundedEventQueue } from './bounded-event-queue.js'

describe('bounded Host event posting', () => {
  it('invalidates an overflowing queue once, releases every caller, and preserves ordered later posts', async () => {
    const observed: number[] = []
    const queue = new BoundedEventQueue(
      () => {
        observed.push(0)
        return Promise.resolve()
      },
      2,
      100,
    )
    let finish: ((value: boolean) => void) | undefined
    const first = queue.enqueue(() => {
      observed.push(1)
      return new Promise((resolve) => {
        finish = resolve
      })
    }, 10)
    const second = queue.enqueue(() => Promise.resolve(true), 10)
    const third = queue.enqueue(() => Promise.resolve(true), 10)
    expect(await queue.enqueue(() => Promise.resolve(true), 10)).toBe(false)
    await expect(second).resolves.toBe(false)
    await expect(third).resolves.toBe(false)
    const later = queue.enqueue(() => {
      observed.push(9)
      return Promise.resolve(true)
    }, 10)
    finish?.(true)
    await expect(first).resolves.toBe(true)
    await expect(later).resolves.toBe(true)
    expect(observed).toEqual([1, 0, 9])
    queue.dispose()
  })

  it('runs control work before queued transcript work while preserving FIFO within each lane', async () => {
    const observed: string[] = []
    let release!: (delivered: boolean) => void
    const queue = new BoundedEventQueue(() => Promise.resolve())
    const blocker = queue.enqueue(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      1,
    )
    const low1 = queue.enqueue(() => {
      observed.push('low1')
      return Promise.resolve(true)
    }, 1)
    const low2 = queue.enqueue(() => {
      observed.push('low2')
      return Promise.resolve(true)
    }, 1)
    const high1 = queue.enqueue(
      () => {
        observed.push('high1')
        return Promise.resolve(true)
      },
      1,
      true,
    )
    const high2 = queue.enqueue(
      () => {
        observed.push('high2')
        return Promise.resolve(true)
      },
      1,
      true,
    )
    release(true)
    await Promise.all([blocker, low1, low2, high1, high2])
    expect(observed).toEqual(['high1', 'high2', 'low1', 'low2'])
    queue.dispose()
  })

  it('uses a character budget, permits one atomic in-flight frame, and clears pending references on disposal', async () => {
    let finish: ((value: boolean) => void) | undefined
    const queue = new BoundedEventQueue(() => Promise.resolve(), 128, 20)
    const first = queue.enqueue(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      100,
    )
    const pending = queue.enqueue(() => Promise.resolve(true), 12)
    expect(await queue.enqueue(() => Promise.resolve(true), 12)).toBe(false)
    await expect(pending).resolves.toBe(false)
    const abandoned = queue.enqueue(() => Promise.resolve(true), 1)
    queue.dispose()
    await expect(abandoned).resolves.toBe(false)
    expect(await queue.enqueue(() => Promise.resolve(true), 1)).toBe(false)
    finish?.(true)
    await first
  })
})
