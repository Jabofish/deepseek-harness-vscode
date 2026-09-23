import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { assertCanonicalSessionEvent, rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Alpha151VersionAdapter, type Alpha151AdapterOptions } from '../src/versions/alpha151/adapter.js'
import {
  validAlpha151SessionEvent,
  validAlpha151SessionSnapshot,
} from '../src/versions/alpha151/session-wire.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { DshStreamController } from '../src/stream-controller.js'
import type { BackendEvent } from '@dsh-vscode/domain'

class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(
    public readonly url: string,
    public readonly options?: unknown,
  ) {
    FakeWebSocket.instances.push(this)
  }

  public send(data: string): void {
    this.sent.push(data)
  }

  public close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    entries.add(listener)
    this.listeners.set(type, entries)
  }

  public removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  public open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  public message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

function response(init: RequestInit | undefined, value: unknown): Response {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function adapterOptions(fetch: typeof globalThis.fetch): Alpha151AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

function streamItem(socket: FakeWebSocket, value: unknown): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: unknown }
  return { type: 'item', streamId: opening.streamId, value }
}

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the alpha151 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`expected ${String(count)} mux frame(s)`)
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user/message',
    seq: 1,
    time: 100,
    surfaceOp: 'append',
    data: {},
    ...overrides,
  }
}

function snapshot(records: readonly unknown[] = [], includeAssistantStream = true): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 3, id: 's1', createdAt: 1, isSeeded: false },
    cursor: 1,
    records,
    hasMore: false,
    projections: { asOfSeq: 1, values: {} },
    ...(includeAssistantStream ? { assistantStream: { revision: 0 } } : {}),
  }
}

describe('DSH 0.1.5-alpha.1 Session wire v3 contract', () => {
  it('selects only the exact v3 adapter and keeps v3 out of compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha151VersionAdapter(adapterOptions(fetch))

    await expect(adapter.probe(candidate('0.1.5-alpha.1'))).resolves.toMatchObject({
      protocolVersion: 'alpha151',
      dshVersion: '0.1.5-alpha.1',
      sessionRestore: false,
      subagentImagePrompts: true,
    })
    await expect(adapter.probe(candidate('0.1.3-alpha.2'))).resolves.toBeUndefined()
    await expect(adapter.probeCompatibility(candidate('0.1.5-alpha.2'))).resolves.toBeUndefined()
  })

  it('enforces exact v3 event metadata and current surface semantics', () => {
    expect(validAlpha151SessionEvent(event())).toBe(true)
    expect(
      validAlpha151SessionEvent(
        event({
          type: 'user/message',
          seq: 4,
          surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
        }),
      ),
    ).toBe(true)
    expect(validAlpha151SessionEvent(event({ futureEventField: 'must-reject' }))).toBe(false)
    expect(validAlpha151SessionEvent(event({ surfaceOp: { op: 'replace', start: 1, end: 2 } }))).toBe(false)
    expect(validAlpha151SessionEvent(event({ sourceEventSeqs: [] }))).toBe(false)
    expect(validAlpha151SessionEvent(event({ sourceEventSeqs: [1] }))).toBe(false)
    expect(
      validAlpha151SessionEvent({
        type: 'future/event',
        seq: 4,
        time: 100,
        data: { opaque: true },
        ignorable: true,
        surfaceOp: { opaque: true },
        sourceEventSeqs: { opaque: true },
      }),
    ).toBe(true)
  })

  it('rejects v3 request/header prompt leakage and contradictory tool errors', () => {
    expect(
      validAlpha151SessionEvent(
        event({ type: 'request/header', data: { header: { system: 'secret prompt' } } }),
      ),
    ).toBe(false)
    expect(
      validAlpha151SessionEvent(
        event({
          type: 'tool/result',
          data: { error: { code: 'FAILED' }, message: { content: [{ type: 'text', text: 'failed' }] } },
        }),
      ),
    ).toBe(false)
    expect(
      validAlpha151SessionEvent(
        event({
          type: 'tool/result',
          data: {
            error: { code: 'FAILED' },
            message: { content: [{ type: 'tool-result', isError: true }] },
          },
        }),
      ),
    ).toBe(true)
    expect(validAlpha151SessionEvent(event({ type: 'tool/result', data: [] }))).toBe(false)
    expect(validAlpha151SessionEvent(event({ type: 'tool/result', data: 'malformed' }))).toBe(false)
  })

  it('keeps system prompts inside the Host and maps PTC events to the existing tool view', () => {
    const system = rc6Mapper.event('system/message', {
      sessionId: 's1',
      data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'secret prompt' }] } },
    })
    expect(system).toEqual({ type: 'session.system', sessionId: 's1' })
    expect(system).not.toHaveProperty('payload')

    const ptcStart = rc6Mapper.event('tool/ptc-dispatch-start', {
      sessionId: 's1',
      data: {
        rootCallId: 'call-1',
        parentCallId: 'call-1',
        subCallId: 'call-1:ptc:1',
        name: 'read_file',
        arguments: { path: 'x' },
      },
    })
    expect(ptcStart).toMatchObject({
      type: 'tool.updated',
      sessionId: 's1',
      tool: {
        id: 'call-1:ptc:1',
        parentCallId: 'call-1',
        name: 'read_file',
        status: 'running',
      },
    })
    const ptc = rc6Mapper.event('tool/ptc-dispatch', {
      sessionId: 's1',
      data: {
        rootCallId: 'call-1',
        parentCallId: 'call-1',
        subCallId: 'call-1:ptc:1',
        name: 'read_file',
        arguments: { path: 'x' },
        isError: false,
        content: [{ type: 'text', text: 'contents' }],
      },
    })
    expect(ptc).toMatchObject({
      type: 'tool.updated',
      sessionId: 's1',
      tool: {
        id: 'call-1:ptc:1',
        parentCallId: 'call-1',
        name: 'read_file',
        status: 'completed',
        outputSummary: 'contents',
      },
    })

    expect(
      rc6Mapper.event('user/message', {
        type: 'user/message',
        seq: 1,
        time: 2,
        sessionId: 's1',
        data: {
          message: {
            id: 'user-1',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'hello' }],
          },
        },
      }),
    ).toMatchObject({ type: 'message.user', markdown: 'hello' })

    const userHistoryEvent = {
      type: 'user/message',
      seq: 1,
      time: 2,
      data: {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'hello' }],
      },
    }
    expect(() =>
      assertCanonicalSessionEvent('user/message', { ...userHistoryEvent, sessionId: 's1' }),
    ).not.toThrow()

    const history = rc6Mapper.history(
      {
        events: [
          {
            event: {
              type: 'system/message',
              seq: 0,
              time: 1,
              data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'secret prompt' }] } },
            },
          },
          {
            event: {
              ...userHistoryEvent,
            },
          },
        ],
        hasMore: false,
      },
      's1',
    )
    expect(history.events).toHaveLength(1)
    expect(history.events[0]?.event).toMatchObject({ type: 'message.user', markdown: 'hello' })
  })

  it('requests assistantStream and accepts the v3 snapshot without exposing system data in the mapped event', async () => {
    FakeWebSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      ...adapterOptions(
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      ),
      endpoint,
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v3',
    })
    const iterator = client.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

    const opening = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly endpoint?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(opening).toMatchObject({
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: 's1' },
            maxMessages: 50,
            assistantStream: true,
          },
        },
      },
    })

    const systemEvent = event({
      type: 'system/message',
      seq: 0,
      data: { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'secret prompt' }] } },
    })
    socket.message(streamItem(socket, snapshot([{ type: 'event', event: systemEvent }])))
    await expect(first).resolves.toMatchObject({
      value: { type: 'session/event', event: { type: 'system/message', seq: 0 } },
    })

    const subscribed = await iterator.next()
    expect(subscribed.value).toMatchObject({ type: 'session/subscribed', sessionId: 's1', lastSeq: 1 })
    expect(validAlpha151SessionSnapshot(snapshot())).toBe(true)

    await iterator.return?.()
    await client.close()
  })

  it('forwards the final assistant message after a mixed live attempt settles', async () => {
    FakeWebSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      ...adapterOptions(
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      ),
      endpoint,
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v3',
    })
    const iterator = client.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const opening = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, snapshot()))
    await expect(opening).resolves.toMatchObject({
      value: { type: 'session/subscribed', sessionId: 's1', lastSeq: 1 },
    })

    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'start',
          attemptId: 'attempt-final',
          revision: 1,
          startedAfterSeq: 1,
          turn: 1,
          step: 2,
        },
      }),
    )
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-final',
          revision: 2,
          index: 0,
          time: 2,
          chunk: { type: 'text-delta', index: 0, text: '替换成功 ✅' },
        },
      }),
    )
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session/assistant-stream',
        frame: { type: 'chunk', chunk: { type: 'text-delta', text: '替换成功 ✅' } },
      },
    })

    const finalEvent = event({
      type: 'assistant/message',
      seq: 2,
      time: 3,
      data: {
        turn: 1,
        step: 2,
        message: {
          id: 'assistant-final',
          role: 'assistant',
          content: [{ type: 'text', text: '替换成功 ✅' }],
          source: { kind: 'model', provider: 'minimax', model: 'MiniMax-M3' },
        },
        stream: [{ type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['替换成功 ✅'] }],
      },
    })
    socket.message(streamItem(socket, { type: 'event', event: finalEvent }))
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-final',
          revision: 3,
          index: 1,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 },
        },
      }),
    )

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'session/event',
        sessionId: 's1',
        event: { ...finalEvent, sessionId: 's1' },
      },
    })
    await iterator.return?.()
    await client.close()
  })

  it('delivers a real mixed multi-tool, multi-request stream through the controller', async () => {
    FakeWebSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      ...adapterOptions(
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      ),
      endpoint,
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v3',
    })
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream('s1', signal),
      closeTransport: false,
    })
    const received: BackendEvent[] = []
    const unsubscribe = controller.subscribe((next) => received.push(next))

    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForSent(socket, 1)

      const wireEvent = (
        type: string,
        seq: number,
        time: number,
        data: Record<string, unknown>,
      ): Record<string, unknown> => ({
        type,
        seq,
        time,
        data,
        ...(new Set(['system/message', 'user/message', 'assistant/message', 'tool/result']).has(type)
          ? { surfaceOp: 'append' }
          : {}),
      })
      const userMessage = wireEvent('user/message', 2, 2, {
        id: 'user-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'inspect the files and report the result' }],
      })
      const snapshotValue = snapshot(
        [
          { type: 'event', event: wireEvent('system/message', 0, 0, { message: { content: [] } }) },
          { type: 'event', event: wireEvent('turn/start', 1, 1, { turn: 1 }) },
          { type: 'event', event: userMessage },
          { type: 'event', event: wireEvent('step/start', 3, 3, { turn: 1, step: 1 }) },
        ],
        true,
      )
      snapshotValue.cursor = 3
      snapshotValue.projections = { asOfSeq: 3, values: {} }
      socket.message(streamItem(socket, snapshotValue))

      for (const expectedType of [
        'session.system',
        'turn.started',
        'message.user',
        'step.started',
        'session.subscribed',
      ])
        await waitForReceived(received, (event) => event.type === expectedType)

      const send = (value: unknown): void => socket.message(streamItem(socket, value))
      send({
        type: 'assistant-stream',
        frame: {
          type: 'start',
          attemptId: 'attempt-1',
          revision: 1,
          startedAfterSeq: 3,
          turn: 1,
          step: 1,
        },
      })
      // Hidden stream bookkeeping must be consumed without creating a false
      // transient gap or swallowing the next visible chunk.
      send({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 2,
          index: 0,
          time: 4,
          chunk: { type: 'reasoning-delta', index: 0, text: '先检查两个文件。' },
        },
      })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 3,
          index: 1,
          time: 5,
          chunk: {
            type: 'tool-call-delta',
            index: 1,
            id: 'call-1',
            name: 'read',
            argumentsDelta: '{"path":"a"}',
          },
        },
      })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 4,
          index: 2,
          time: 6,
          chunk: {
            type: 'block-end',
            index: 1,
            block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
          },
        },
      })
      send({
        type: 'event',
        event: wireEvent('assistant/message', 4, 7, {
          turn: 1,
          step: 1,
          message: {
            id: 'assistant-tool-request',
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }],
            source: { kind: 'model', provider: 'minimax', model: 'MiniMax-M3' },
          },
          stream: [],
        }),
      })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-1',
          revision: 5,
          index: 3,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 },
        },
      })
      send({
        type: 'event',
        event: wireEvent('tool/call', 5, 8, {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'read',
          arguments: '{"path":"a"}',
        }),
      })
      send({
        type: 'event',
        event: wireEvent('tool/result', 6, 9, {
          turn: 1,
          step: 1,
          callId: 'call-1',
          message: {
            id: 'tool-result-1',
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'a contents' }] },
            ],
            source: { kind: 'tool', callId: 'call-1' },
          },
          meta: { path: 'a', offset: 1, lines: [{ number: 1, text: 'a contents' }], totalLines: 1 },
        }),
      })
      send({
        type: 'event',
        event: wireEvent('tool/call', 7, 10, {
          turn: 1,
          step: 1,
          callId: 'call-2',
          name: 'read',
          arguments: '{"path":"b"}',
        }),
      })
      send({
        type: 'event',
        event: wireEvent('tool/result', 8, 11, {
          turn: 1,
          step: 1,
          callId: 'call-2',
          message: {
            id: 'tool-result-2',
            role: 'user',
            content: [
              { type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'b contents' }] },
            ],
            source: { kind: 'tool', callId: 'call-2' },
          },
        }),
      })
      send({ type: 'event', event: wireEvent('step/end', 9, 12, { turn: 1, step: 1 }) })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'start',
          attemptId: 'attempt-2',
          revision: 6,
          startedAfterSeq: 9,
          turn: 1,
          step: 2,
        },
      })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-2',
          revision: 7,
          index: 0,
          time: 13,
          chunk: { type: 'text-delta', index: 0, text: '检查完成，两个文件都正常。' },
        },
      })
      const finalEvent = wireEvent('assistant/message', 10, 14, {
        turn: 1,
        step: 2,
        message: {
          id: 'assistant-final',
          role: 'assistant',
          content: [{ type: 'text', text: '检查完成，两个文件都正常。' }],
          source: { kind: 'model', provider: 'minimax', model: 'MiniMax-M3' },
        },
        stream: [{ type: 'text-chunks', time0: 13, index: 0, dt: [], texts: ['检查完成，两个文件都正常。'] }],
      })
      send({ type: 'event', event: finalEvent })
      send({
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-2',
          revision: 8,
          index: 1,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 10 },
        },
      })
      send({
        type: 'event',
        event: wireEvent('deliverables/presented', 11, 15, {
          turn: 1,
          callId: 'call-2',
          files: [{ path: 'report.md', description: 'report' }],
        }),
      })
      send({ type: 'event', event: wireEvent('step/end', 12, 16, { turn: 1, step: 2 }) })
      send({
        type: 'event',
        event: wireEvent('turn/end', 13, 17, { turn: 1, reason: { kind: 'completed' } }),
      })

      await waitForReceived(received, (event) => event.type === 'message.completed' && event.sequence === 10)
      await waitForReceived(received, (event) => event.type === 'turn.ended' && event.sequence === 13)

      const durable = received.filter(
        (event) =>
          event.type !== 'session.subscribed' &&
          event.type !== 'message.delta' &&
          event.type !== 'reasoning.delta',
      )
      expect(durable.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
      expect(received).toContainEqual(
        expect.objectContaining({
          type: 'message.completed',
          sequence: 10,
          messageId: 'assistant-final',
          markdown: '检查完成，两个文件都正常。',
        }),
      )
      // The v3 wire carries no tool view: the settled card has to come from the
      // result event's own metadata, on the same stream that delivers it.
      const settled = received.find(
        (event): event is Extract<BackendEvent, { readonly type: 'tool.updated' }> =>
          event.type === 'tool.updated' && event.tool.id === 'call-1' && event.tool.status === 'completed',
      )
      expect(settled?.tool).toMatchObject({
        id: 'call-1',
        status: 'completed',
        presentation: {
          phase: 'result',
          card: 'read',
          path: 'a',
          offset: 1,
          lines: [{ number: 1, text: 'a contents' }],
          totalLines: 1,
        },
      })
    } finally {
      unsubscribe()
      await controller.close()
      await client.close()
    }
  })

  it('requires the v3 assistant baseline and rejects a malformed snapshot', async () => {
    FakeWebSocket.instances.length = 0
    const client = new AlphaLoopbackApiClient({
      ...adapterOptions(
        vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      ),
      endpoint,
      webSocket: FakeWebSocket,
      sessionWireVersion: 'v3',
    })
    const iterator = client.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, snapshot([], false)))

    await expect(first).resolves.toMatchObject({ value: { type: 'session/subscribed' } })
    await expect(iterator.next()).rejects.toThrow(/assistant stream baseline/u)
    await iterator.return?.()
    await client.close()
  })
})

async function waitForReceived(
  received: readonly BackendEvent[],
  predicate: (event: BackendEvent) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (received.some(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(
    `timed out waiting for the expected controller event: ${received.map((event) => `${event.type}:${String(event.sequence ?? '')}`).join(',')}`,
  )
}
