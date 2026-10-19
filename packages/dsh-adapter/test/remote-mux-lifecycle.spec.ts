import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlphaRemoteMux, type AlphaWebSocket } from '../src/versions/alpha/remote-mux.js'

class Socket implements AlphaWebSocket {
  static instances: Socket[] = []
  readyState = 0
  sent: Array<{ type: string; streamId: string }> = []
  listeners = new Map<string, Set<(event: unknown) => void>>()
  constructor() {
    Socket.instances.push(this)
  }
  send(text: string): void {
    this.sent.push(JSON.parse(text) as { type: string; streamId: string })
  }
  // Closing a real socket in CONNECTING need not deliver close synchronously.
  close(): void {
    this.readyState = 3
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type) ?? new Set()
    entries.add(listener)
    this.listeners.set(type, entries)
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, event: unknown): void {
    for (const sink of this.listeners.get(type) ?? []) sink(event)
  }
  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }
  item(streamId: string, value: unknown): void {
    this.emit('message', { data: JSON.stringify({ type: 'item', streamId, value }) })
  }
}

function fixture(): AlphaRemoteMux {
  Socket.instances = []
  return new AlphaRemoteMux({
    endpoint: { host: '127.0.0.1', port: 1234, baseUrl: 'http://127.0.0.1:1234' },
    requestTimeoutMs: 60_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(),
    webSocket: Socket,
  })
}

async function opening(
  mux: AlphaRemoteMux,
  endpoint: string,
  signal?: AbortSignal,
): Promise<{
  readonly iterator: AsyncGenerator<unknown>
  readonly first: Promise<IteratorResult<unknown>>
  readonly socket: Socket
  readonly id: string
}> {
  const iterator = mux.open(endpoint, {}, signal)
  const first = iterator.next()
  const socket = Socket.instances[0]!
  socket.open()
  await vi.waitFor(() => expect(socket.sent.filter((frame) => frame.type === 'open')).toHaveLength(1))
  return { iterator, first, socket, id: socket.sent[0]!.streamId }
}

afterEach(() => vi.useRealTimers())

describe('Remote mux lifecycle regressions', () => {
  it('preserves a small session token burst while the async consumer is suspended', async () => {
    const mux = fixture()
    try {
      const { iterator, first, socket, id } = await opening(mux, 'session/follow')
      socket.item(id, { type: 'snapshot' })
      await first
      // One network read can dispatch hundreds of tiny frames before the async
      // iterator resumes. They are ordered data, not recoverable history rows.
      for (let index = 0; index < 32; index++) socket.item(id, { index, text: 'token' })
      for (let index = 0; index < 32; index++)
        expect(await iterator.next()).toEqual({ done: false, value: { index, text: 'token' } })
      expect(socket.sent.filter((frame) => frame.type === 'cancel')).toHaveLength(0)
    } finally {
      await mux.close()
    }
  })

  it('does not drain buffered items after the caller cancels', async () => {
    const mux = fixture()
    const controller = new AbortController()
    const { iterator, first, socket, id } = await opening(mux, 'job/follow', controller.signal)
    socket.item(id, 'first')
    await expect(first).resolves.toEqual({ done: false, value: 'first' })
    socket.item(id, 'late')
    controller.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(socket.sent.filter((frame) => frame.type === 'cancel')).toHaveLength(1)
    await mux.close()
  })

  it.each(['count', 'bytes'] as const)(
    'rebaselines only the overflowing session (%s budget)',
    { tags: ['stress'] },
    async (budget) => {
      const mux = fixture()
      try {
        const { iterator, first, socket, id } = await opening(mux, 'session/follow')
        socket.item(id, { type: 'snapshot' })
        await first
        const value = budget === 'bytes' ? 'x'.repeat(2 * 1024 * 1024) : 'token'
        for (let index = 0; index < 10_000 && !socket.sent.some((frame) => frame.type === 'cancel'); index++)
          socket.item(id, value)
        await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', retryable: true })
        expect(socket.sent).toContainEqual({ type: 'cancel', streamId: id })
        expect(socket.readyState).toBe(1)
      } finally {
        await mux.close()
      }
    },
  )

  it('settles a pending handshake immediately when disposed without a socket close event', async () => {
    vi.useFakeTimers()
    const mux = fixture()
    const iterator = mux.open('job/list', {})
    const first = iterator.next()
    const outcome = first.then(
      () => 'ended',
      () => 'failed',
    )
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await mux.close()
    for (let index = 0; index < 15; index += 1) await Promise.resolve()
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect([...Socket.instances[0]!.listeners.values()].every((entries) => entries.size === 0)).toBe(true)
    await outcome
  })

  it('fails a non-durable projection stream instead of silently discarding updates on overflow', async () => {
    const mux = fixture()
    const { iterator, first, socket, id } = await opening(mux, 'session/control')
    socket.item(id, { type: 'baseline' })
    await first
    for (let index = 0; index < 300; index += 1)
      socket.item(id, { type: 'projection', sessionId: `s${index}` })
    await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', retryable: true })
    expect(socket.sent).toContainEqual({ type: 'cancel', streamId: id })
    // Overflow belongs to this logical stream; its siblings keep the carrier.
    expect(socket.readyState).toBe(1)
    await mux.close()
  })

  it('does not drain buffered items after the entire transport closes', async () => {
    const mux = fixture()
    const { iterator, first, socket, id } = await opening(mux, 'job/follow')
    socket.item(id, 'first')
    await first
    socket.item(id, 'late')
    await mux.close()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })
})
