import { describe, expect, it, vi } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { ControlDelivery } from './control-delivery.js'

type Event = Extract<HostMessage, { type: 'event' }>
const event = (name: string, payload: unknown = {}): Event => ({ type: 'event', name, sequence: 0, payload })
async function tick(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

describe('surface control consumption', () => {
  it('isolates slow consumers and coalesces snapshots until the actual consumer ACK', async () => {
    const posted = new Map<string, Event[]>()
    let sequence = 0
    const delivery = new ControlDelivery(
      (surfaceId, message) => {
        const frames = posted.get(surfaceId) ?? []
        frames.push(message)
        posted.set(surfaceId, frames)
        if (surfaceId === 'fast') delivery.acknowledge(surfaceId, message.sequence)
        return Promise.resolve(true)
      },
      () => ++sequence,
      () => true,
    )
    try {
      const stalled = delivery.enqueue('slow', event('session.status', { status: 'running' }), 'status')
      for (let index = 0; index < 1000; index++)
        void delivery.enqueue('slow', event('session.status', { status: index }), 'status')
      await tick()
      expect(posted.get('slow')).toHaveLength(1)
      await delivery.enqueue('fast', event('question.requested'))
      expect(posted.get('fast')).toHaveLength(1)
      delivery.acknowledge('slow', posted.get('slow')![0]!.sequence)
      await stalled
      await tick()
      expect(posted.get('slow')).toHaveLength(2)
      expect(posted.get('slow')![1]!.payload).toEqual({ status: 999 })
      expect(posted.get('slow')!.every((message) => message.requiresAck === true)).toBe(true)
    } finally {
      delivery.dispose()
    }
  })

  it('preserves interaction barriers and original ordering across a failed receipt', async () => {
    vi.useFakeTimers()
    const posted: Event[] = []
    let available = false,
      sequence = 0
    const delivery = new ControlDelivery(
      (surfaceId, message) => {
        posted.push(message)
        if (available) delivery.acknowledge(surfaceId, message.sequence)
        return Promise.resolve(available)
      },
      () => ++sequence,
      () => true,
    )
    try {
      await expect(delivery.enqueue('s', event('question.requested', { id: 'q' }))).resolves.toBe(false)
      await tick()
      expect(posted).toHaveLength(1)
      available = true
      const resolved = delivery.enqueue('s', event('question.resolved', { id: 'q' }))
      await vi.advanceTimersByTimeAsync(100)
      await resolved
      expect(posted.map((frame) => frame.name)).toEqual([
        'question.requested',
        'question.requested',
        'question.resolved',
      ])
      expect(posted.map((frame) => frame.sequence)).toEqual([1, 2, 3])
      expect(posted.some((frame) => frame.name === 'ui.resync')).toBe(false)
    } finally {
      delivery.dispose()
      vi.useRealTimers()
    }
  })

  it('retries a lost final control fact with bounded backoff and cancels retries on disposal', async () => {
    vi.useFakeTimers()
    const post = vi.fn(() => Promise.resolve(false))
    let sequence = 0
    const delivery = new ControlDelivery(
      post,
      () => ++sequence,
      () => true,
    )
    try {
      await delivery.enqueue('s', event('question.requested'))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(post).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(100_000)
      expect(post).toHaveBeenCalledTimes(4)
      delivery.forget('s')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      delivery.dispose()
      vi.useRealTimers()
    }
  })

  it('does not move a replacement snapshot across a lifecycle barrier', async () => {
    const posted: Event[] = []
    let sequence = 0
    const delivery = new ControlDelivery(
      (_, message) => {
        posted.push(message)
        return Promise.resolve(true)
      },
      () => ++sequence,
      () => true,
    )
    try {
      void delivery.enqueue('s', event('connection.snapshot'))
      void delivery.enqueue('s', event('session.status', 'before'), 'status')
      void delivery.enqueue('s', event('question.requested'))
      void delivery.enqueue('s', event('session.status', 'after'), 'status')
      await tick()
      for (let index = 0; index < 3; index++) {
        delivery.acknowledge('s', posted[index]!.sequence)
        await tick()
      }
      expect(posted.map((frame) => [frame.name, frame.payload])).toEqual([
        ['connection.snapshot', {}],
        ['session.status', 'before'],
        ['question.requested', {}],
        ['session.status', 'after'],
      ])
    } finally {
      delivery.dispose()
    }
  })

  it('falls back to one surface baseline only when retained facts exceed the mailbox budget', async () => {
    const posted: Array<[string, Event]> = []
    let sequence = 0
    const delivery = new ControlDelivery(
      (id, message) => {
        posted.push([id, message])
        return Promise.resolve(true)
      },
      () => ++sequence,
      () => true,
      3,
      1024,
    )
    try {
      void delivery.enqueue('slow', event('connection.snapshot'))
      for (let index = 0; index < 4; index++)
        void delivery.enqueue('slow', event('question.requested', { id: index }))
      await tick()
      expect(posted).toHaveLength(1)
      delivery.acknowledge('slow', posted[0]![1].sequence)
      await tick()
      expect(posted[1]).toEqual(['slow', expect.objectContaining({ name: 'ui.resync' })])
      expect(posted).toHaveLength(2)
    } finally {
      delivery.dispose()
    }
  })

  it('rejects forged ACKs, skips retired frames and releases waiters on surface disposal', async () => {
    let sequence = 0,
      valid = true
    const post = vi.fn(() => Promise.resolve(true))
    const delivery = new ControlDelivery(
      post,
      () => ++sequence,
      () => true,
    )
    const pending = delivery.enqueue('s', event('connection.snapshot'))
    const retired = delivery.enqueue('s', event('session.status'), undefined, () => valid)
    await tick()
    valid = false
    delivery.acknowledge('s', 100)
    await tick()
    expect(post).toHaveBeenCalledTimes(1)
    delivery.acknowledge('s', 1)
    await expect(pending).resolves.toBe(true)
    await expect(retired).resolves.toBe(true)
    expect(post).toHaveBeenCalledTimes(1)
    const abandoned = delivery.enqueue('s', event('question.requested'))
    delivery.forget('s')
    await expect(abandoned).resolves.toBe(false)
    delivery.dispose()
  })
})
