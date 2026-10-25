import { describe, expect, it, vi } from 'vitest'
import { BoundedEventQueue } from './bounded-event-queue.js'

describe('bounded Host event posting', () => {
  it('keeps only the latest snapshot across async arrivals while a receipt is stalled, and fences it before a baseline', async () => {
    const queue = new BoundedEventQueue(() => Promise.resolve())
    const posted: number[] = []
    let release!: (delivered: boolean) => void
    const first = queue.enqueueLatest(
      'activity',
      () => {
        posted.push(1)
        return new Promise<boolean>((resolve) => {
          release = resolve
        })
      },
      10,
      true,
      1,
    )
    expect(posted).toEqual([1])
    const waiters: Promise<boolean>[] = []
    for (let value = 2; value <= 40; value++) {
      waiters.push(
        queue.enqueueLatest(
          'activity',
          () => {
            posted.push(value)
            return Promise.resolve(true)
          },
          10,
          true,
          value,
        ),
      )
      await Promise.resolve()
    }
    expect(posted).toEqual([1])
    // A stale snapshot must not replace the pending value 40.
    waiters.push(
      queue.enqueueLatest(
        'activity',
        () => {
          posted.push(3)
          return Promise.resolve(true)
        },
        10,
        true,
        3,
      ),
    )
    await queue.enqueue(
      () => {
        posted.push(41)
        return Promise.resolve(true)
      },
      1,
      true,
    )
    expect(posted).toEqual([1, 40, 41])
    release(true)
    expect(await Promise.all([first, ...waiters])).not.toContain(false)
    queue.dispose()
  })

  it('charges replacement bytes, bounds pending keys and resolves them on disposal', async () => {
    const recovery = vi.fn(() => Promise.resolve())
    const queue = new BoundedEventQueue(recovery, 2, 100)
    const first = queue.enqueueLatest('one', () => new Promise(() => undefined), 10, true)
    const second = queue.enqueueLatest('two', () => new Promise(() => undefined), 10, true)
    await Promise.resolve()
    const pending = queue.enqueueLatest('one', () => Promise.resolve(true), 10, true)
    const pendingTwo = queue.enqueueLatest('two', () => Promise.resolve(true), 10, true)
    expect(await queue.enqueueLatest('one', () => Promise.resolve(true), 95, true)).toBe(false)
    expect(await pending).toBe(false)
    expect(recovery).toHaveBeenCalledWith({ priority: true })
    queue.dispose()
    expect(await Promise.all([first, second, pendingTwo])).toEqual([false, false, false])
  })

  it('rate limits repeated priority recovery and cancels the trailing request on disposal', async () => {
    vi.useFakeTimers()
    const recovery = vi.fn(() => Promise.resolve())
    const queue = new BoundedEventQueue(recovery)
    try {
      queue.invalidate()
      for (let index = 0; index < 40; index++) {
        await Promise.resolve()
        queue.invalidate()
      }
      expect(recovery).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(recovery).toHaveBeenCalledTimes(2)
      queue.invalidate()
      queue.dispose()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(recovery).toHaveBeenCalledTimes(2)
    } finally {
      queue.dispose()
      vi.useRealTimers()
    }
  })

  it('invokes text and control IPC in source order without awaiting earlier receipts', async () => {
    const observed: string[] = []
    let release!: (value: boolean) => void
    const queue = new BoundedEventQueue(() => Promise.resolve())
    const first = queue.enqueue(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      1,
    )
    const ordinary = queue.enqueue(() => {
      observed.push('text')
      return Promise.resolve(true)
    }, 1)
    const tool = queue.enqueue(() => {
      observed.push('tool')
      return Promise.resolve(true)
    }, 1)
    const question = queue.enqueue(
      () => {
        observed.push('question')
        return Promise.resolve(true)
      },
      1,
      true,
    )
    await Promise.all([ordinary, tool, question])
    expect(observed).toEqual(['text', 'tool', 'question'])
    release(true)
    await expect(first).resolves.toBe(true)
    queue.dispose()
  })

  it('bounds outstanding work, reserves control capacity and retains actual delivery results', async () => {
    const resync = vi.fn(() => Promise.resolve())
    const queue = new BoundedEventQueue(resync, 2, 100)
    const releases: ((value: boolean) => void)[] = []
    const post = (): Promise<boolean> => new Promise((resolve) => releases.push(resolve))
    const first = queue.enqueue(post, 10)
    const second = queue.enqueue(post, 10)
    expect(await queue.enqueue(post, 10)).toBe(false)
    expect(resync).toHaveBeenCalledOnce()
    expect(releases).toHaveLength(2)
    await expect(queue.enqueue(() => Promise.resolve(true), 1, true)).resolves.toBe(true)
    releases.forEach((release) => release(true))
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    await expect(queue.enqueue(() => Promise.resolve(true), 1)).resolves.toBe(true)
    queue.dispose()
  })

  it('permits one atomic oversized frame and releases waiters on disposal despite late receipts', async () => {
    const queue = new BoundedEventQueue(() => Promise.resolve(), 128, 20)
    let release!: (value: boolean) => void
    const first = queue.enqueue(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
      100,
    )
    expect(await queue.enqueue(() => Promise.resolve(true), 1)).toBe(false)
    queue.dispose()
    await expect(first).resolves.toBe(false)
    expect(await queue.enqueue(() => Promise.resolve(true), 1)).toBe(false)
    release(true)
  })

  it('releases budgets after synchronous and asynchronous delivery failures', async () => {
    const queue = new BoundedEventQueue(() => Promise.resolve(), 1, 20)
    await expect(
      queue.enqueue(() => {
        throw new Error('post failed')
      }, 1),
    ).resolves.toBe(false)
    await expect(queue.enqueue(() => Promise.reject(new Error('post rejected')), 1)).resolves.toBe(false)
    await expect(queue.enqueue(() => Promise.resolve(true), 1)).resolves.toBe(true)
    queue.dispose()
  })
})
