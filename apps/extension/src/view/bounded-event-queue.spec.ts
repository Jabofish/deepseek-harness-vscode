import { describe, expect, it, vi } from 'vitest'
import { BoundedEventQueue } from './bounded-event-queue.js'

describe('bounded Host event posting', () => {
  it('bounds outstanding work, reserves control capacity and retains actual delivery results', async () => {
    const resync = vi.fn(() => Promise.resolve())
    const queue = new BoundedEventQueue(resync, 2, 100)
    const releases: ((value: boolean) => void)[] = []
    const post = (): Promise<boolean> => new Promise((resolve) => releases.push(resolve))
    const first = queue.enqueue(post, 10)
    const second = queue.enqueue(post, 10)
    expect(await queue.enqueue(post, 10)).toBe(false)
    expect(resync).toHaveBeenCalled()
    await expect(queue.enqueue(() => Promise.resolve(true), 1, true)).resolves.toBe(true)
    releases.forEach((release) => release(true))
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    await expect(queue.enqueue(() => Promise.resolve(true), 1)).resolves.toBe(true)
    queue.dispose()
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
