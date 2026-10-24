import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import { DshStreamController } from '../src/stream-controller.js'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import type { AlphaV4SessionProfile } from '../src/versions/alpha171/session-wire.js'
import { FakeWebSocket } from './support/fake-web-socket.js'

// Synthetic session/follow fixture from dsh-v0.1.7-alpha.1 / c36a83ff:
// packages/api/session-controller/src/types.ts and session-format-v3-to-v4/src/codec.ts.
function snapshot(count = 8): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 4, id: 's1', createdAt: 1, isSeeded: false },
    cursor: count - 1,
    hasMore: false,
    projections: { asOfSeq: count - 1, values: {} },
    records: Array.from({ length: count }, (_, seq) => ({
      type: 'event',
      event: { type: 'turn/start', seq, time: seq + 1, data: { turn: seq + 1 } },
    })),
  }
}

function createTransport(validateEvent: () => void): AlphaLoopbackApiClient {
  FakeWebSocket.instances.length = 0
  const profile: AlphaV4SessionProfile = { eventValidators: {}, validateEvent }
  return new AlphaLoopbackApiClient({
    endpoint: { host: '127.0.0.1', port: 4567, baseUrl: 'http://127.0.0.1:4567' },
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(() => Promise.reject(new Error('Snapshot tests must not make HTTP requests.'))),
    authCookie: () => 'dsh_session=fixture',
    webSocket: FakeWebSocket,
    sessionWireVersion: 'v4',
    sessionWireProfile: profile,
  })
}

async function openFollow(previousStreamId?: string): Promise<{ socket: FakeWebSocket; streamId: string }> {
  const socket = await vi.waitFor(() => {
    const instance = FakeWebSocket.instances[0]
    if (instance === undefined) throw new Error('The mux socket has not been created.')
    return instance
  })
  if (socket.readyState === 0) socket.open()
  const streamId = await vi.waitFor(() => {
    for (const sent of socket.sent) {
      const frame = JSON.parse(sent) as Record<string, unknown>
      if (
        frame.type === 'open' &&
        frame.endpoint === 'session/follow' &&
        typeof frame.streamId === 'string' &&
        frame.streamId !== previousStreamId
      )
        return frame.streamId
    }
    throw new Error('The session/follow stream has not opened.')
  })
  return { socket, streamId }
}

afterEach(() => vi.restoreAllMocks())

describe('alpha171 incremental snapshot transport', () => {
  it('yields while notifying subscribers and keeps the baseline ahead of queued live events', async () => {
    const transport = createTransport(vi.fn())
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) => transport.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const events: BackendEvent[] = []
    const count = 129
    let callback: NodeJS.Immediate | undefined
    let deliveredAtCallback = 0
    let baselineAtCallback = false
    let onFirstDelivery = (): void => undefined
    controller.subscribe((event) => {
      events.push(event)
      if (events.length === 1) onFirstDelivery()
    })
    try {
      const { socket, streamId } = await openFollow()
      onFirstDelivery = () => {
        callback = setImmediate(() => {
          deliveredAtCallback = events.length
          baselineAtCallback = events.some((event) => event.type === 'session.subscribed')
          socket.message({
            type: 'item',
            streamId,
            value: {
              type: 'event',
              event: { type: 'turn/start', seq: count, time: count + 1, data: { turn: count + 1 } },
            },
          })
        })
      }
      socket.message({ type: 'item', streamId, value: snapshot(count) })
      await vi.waitFor(() => expect(events).toHaveLength(count + 2))

      expect(deliveredAtCallback).toBeGreaterThan(0)
      expect(deliveredAtCallback).toBeLessThan(count)
      expect(baselineAtCallback).toBe(false)
      expect(events.slice(0, count).map((event) => event.sequence)).toEqual(
        Array.from({ length: count }, (_, index) => index),
      )
      expect(events[count]).toMatchObject({ type: 'session.subscribed', lastSequence: count - 1 })
      expect(events[count + 1]).toMatchObject({ type: 'turn.started', sequence: count })
    } finally {
      clearImmediate(callback)
      await controller.close()
      await transport.close()
    }
  })

  it.each(['close', 'restart'] as const)('can %s between subscriber delivery batches', async (action) => {
    const transport = createTransport(vi.fn())
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) => transport.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const events: BackendEvent[] = []
    const count = 129
    let callback: NodeJS.Immediate | undefined
    let onFirstDelivery = (): void => undefined
    controller.subscribe((event) => {
      events.push(event)
      if (events.length === 1) onFirstDelivery()
    })
    try {
      const { socket, streamId } = await openFollow()
      const actionFinished = new Promise<void>((resolve, reject) => {
        onFirstDelivery = () => {
          callback = setImmediate(() => {
            void controller[action]().then(resolve, reject)
          })
        }
      })
      socket.message({ type: 'item', streamId, value: snapshot(count) })
      await actionFinished

      const oldCount = events.length
      expect(oldCount).toBeGreaterThan(0)
      expect(oldCount).toBeLessThan(count)
      expect(events.every((event) => event.type === 'turn.started')).toBe(true)
      expect(socket.sent.map((sent) => JSON.parse(sent) as unknown)).toContainEqual({
        type: 'cancel',
        streamId,
      })
      expect(socket.closeCalls).toBe(0)
      if (action === 'restart') {
        const next = await openFollow(streamId)
        next.socket.message({ type: 'item', streamId: next.streamId, value: snapshot(1) })
        await vi.waitFor(() => expect(events).toHaveLength(oldCount + 2))
        expect(events.slice(oldCount)).toMatchObject([
          { type: 'turn.started', sequence: 0, replayed: true },
          { type: 'session.subscribed', lastSequence: 0 },
        ])
      }
    } finally {
      clearImmediate(callback)
      await controller.close()
      await transport.close()
    }
  })

  it('yields during follow snapshots and admits each record only once before publishing the baseline', async () => {
    let clock = 0
    const validateEvent = vi.fn(() => {
      clock += 60
    })
    const transport = createTransport(validateEvent)
    const abort = new AbortController()
    const iterator = transport.openSessionStream('s1', abort.signal)[Symbol.asyncIterator]()
    let callback: NodeJS.Immediate | undefined

    try {
      const first = iterator.next()
      const { socket, streamId } = await openFollow()
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      let decodedAtCallback: number | undefined
      callback = setImmediate(() => {
        decodedAtCallback = validateEvent.mock.calls.length
      })
      socket.message({ type: 'item', streamId, value: snapshot() })

      const events = [(await first).value]
      for (let index = 1; index < 8; index += 1) events.push((await iterator.next()).value)
      expect(events).toEqual(
        Array.from({ length: 8 }, (_, seq) => ({
          type: 'session/event',
          sessionId: 's1',
          event: { type: 'turn/start', seq, time: seq + 1, data: { turn: seq + 1 }, sessionId: 's1' },
        })),
      )
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: {
          type: 'session/subscribed',
          sessionId: 's1',
          lastSeq: 7,
          controlBaseline: false,
          projections: { asOfSeq: 7, values: {} },
        },
      })
      expect(validateEvent).toHaveBeenCalledTimes(8)
      expect(decodedAtCallback).toBeGreaterThan(0)
      expect(decodedAtCallback).toBeLessThan(8)
    } finally {
      clearImmediate(callback)
      abort.abort()
      await iterator.return?.()
      await transport.close()
    }
  })

  it('suppresses a snapshot canceled during decode and releases its logical follow stream', async () => {
    let clock = 0
    const validateEvent = vi.fn(() => {
      clock += 60
    })
    const transport = createTransport(validateEvent)
    const controller = new DshStreamController(transport, undefined, undefined, {
      streamSource: (signal) => transport.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const events: BackendEvent[] = []
    controller.subscribe((event) => events.push(event))
    let callback: NodeJS.Immediate | undefined

    try {
      const { socket, streamId } = await openFollow()
      vi.spyOn(performance, 'now').mockImplementation(() => clock)
      let decodedAtCancel: number | undefined
      const closed = new Promise<void>((resolve, reject) => {
        callback = setImmediate(() => {
          decodedAtCancel = validateEvent.mock.calls.length
          void controller.close().then(resolve, reject)
        })
      })
      socket.message({ type: 'item', streamId, value: snapshot() })
      await closed

      expect(decodedAtCancel).toBeGreaterThan(0)
      expect(decodedAtCancel).toBeLessThan(8)
      expect(events).toEqual([])
      expect(socket.sent.map((sent) => JSON.parse(sent) as unknown)).toContainEqual({
        type: 'cancel',
        streamId,
      })
      expect(socket.closeCalls).toBe(0)
      expect(socket.readyState).toBe(1)
    } finally {
      clearImmediate(callback)
      await controller.close()
      await transport.close()
    }
  })
})
