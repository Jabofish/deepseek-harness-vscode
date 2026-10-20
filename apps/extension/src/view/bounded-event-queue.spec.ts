import { describe, expect, it, vi } from 'vitest'
import { BoundedEventQueue } from './bounded-event-queue.js'

describe('bounded Host event posting', () => {
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
