import { describe, expect, it, vi } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Rc6CommandRepository } from '../src/repositories/command-repository.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { Alpha5VersionAdapter } from '../src/versions/alpha5/adapter.js'
import { Alpha13AssistantStreamProjector } from '../src/versions/alpha13/session-wire.js'
import { Alpha13VersionAdapter } from '../src/versions/alpha13/adapter.js'
import { candidate, endpoint, wrappedResponse as response } from './support/contract-harness.js'

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

function transport(fetch: typeof globalThis.fetch): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
    sessionWireVersion: 'v2',
  })
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
  throw new Error('the alpha13 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`expected ${String(count)} mux frame(s)`)
}

function commandTransport(
  commands: { readonly method: string; readonly params: unknown }[],
  directory: unknown = [],
): DshTransport {
  return {
    request: <TResponse>(method: string) =>
      Promise.resolve({
        result: {
          ok: true,
          value: method === 'session.history' ? { events: [], hasMore: false } : { items: [] },
        },
      } as TResponse),
    remoteRequest: <TResponse>(method: string, params: unknown) => {
      commands.push({ method, params })
      return Promise.resolve({
        ok: true,
        value:
          method === 'commands/list'
            ? directory
            : { commandId: 'alpha13-command', result: { kind: 'success', text: 'applied' } },
      } as TResponse)
    },
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

function snapshot(includeAssistantStream = true): Record<string, unknown> {
  return {
    type: 'snapshot',
    header: { version: 1, id: 's1', createdAt: 1, isSeeded: false, futureHeaderField: 'ignored' },
    cursor: 0,
    records: [],
    hasMore: false,
    projections: { asOfSeq: 0, values: {} },
    ...(includeAssistantStream ? { assistantStream: { revision: 0 } } : {}),
  }
}

describe('DSH 0.1.3-alpha.1 Session v2 contract', () => {
  it('selects the exact latest source snapshot but declines unverified v2 fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha13VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch,
    })

    await expect(adapter.probe(candidate('0.1.3-alpha.1'))).resolves.toMatchObject({
      protocolVersion: 'alpha13',
      dshVersion: '0.1.3-alpha.1',
      subagentImagePrompts: true,
    })

    await expect(adapter.probeCompatibility(candidate('0.1.3-alpha.2'))).resolves.toBeUndefined()

    const connected = await new VersionedBackendProbe([
      adapter,
      new Alpha5VersionAdapter({
        requestTimeoutMs: 1_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
        fetch,
      }),
    ]).probe(candidate('0.1.3-alpha.3'))

    expect(connected).toMatchObject({
      capabilities: {
        protocolVersion: 'alpha5',
        dshVersion: '0.1.3-alpha.3',
        adapterId: 'dsh-0.1.2-alpha.5',
        compatibilityMode: 'best-effort',
        subagentImagePrompts: false,
      },
    })
    expect(connected?.capabilities.compatibilityWarning).toContain(
      'newest safe fallback adapter is 0.1.2-alpha.5',
    )
  })

  it('requests assistantStream and folds start, durable settlement, chunk, and end in wire order', async () => {
    FakeWebSocket.instances.length = 0
    const client = transport(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
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

    socket.message(streamItem(socket, snapshot()))
    await expect(first).resolves.toMatchObject({
      value: { type: 'session/subscribed', lastSeq: 0, controlBaseline: false },
    })

    const chunkNext = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'start',
          attemptId: 'attempt-1',
          revision: 1,
          startedAfterSeq: 0,
          turn: 1,
          step: 1,
        },
      }),
    )
    socket.message(
      streamItem(socket, {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 1,
          time: 101,
          surfaceOp: 'append',
          futureEventField: 'ignored',
          data: { turn: 1, step: 1, message: {} },
        },
      }),
    )
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 2,
          index: 0,
          time: 102,
          chunk: { type: 'text-delta', index: 0, text: 'hello' },
        },
      }),
    )
    await expect(chunkNext).resolves.toMatchObject({
      value: {
        type: 'session/assistant-stream',
        sessionId: 's1',
        transientSequence: 1,
        frame: {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 2,
          index: 0,
          turn: 1,
          step: 1,
          startedAfterSeq: 0,
        },
      },
    })

    const settlementNext = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt-1',
          revision: 3,
          index: 1,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
        },
      }),
    )
    const settlement = await settlementNext
    expect(settlement).toMatchObject({
      value: { type: 'session/event', sessionId: 's1', event: { type: 'assistant/message', seq: 1 } },
    })
    expect((settlement.value as { readonly event?: Record<string, unknown> }).event).not.toHaveProperty(
      'futureEventField',
    )

    await iterator.return?.()
    await client.close()
  })

  it('rejects a v2 snapshot without the assistant stream baseline', async () => {
    FakeWebSocket.instances.length = 0
    const client = transport(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const iterator = client.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, snapshot(false)))

    await expect(first).resolves.toMatchObject({ value: { type: 'session/subscribed', lastSeq: 0 } })
    await expect(iterator.next()).rejects.toThrow(/session\/follow assistant stream baseline/u)
    await iterator.return?.()
    await client.close()
  })

  it('reconstructs compact reconnect chunks and rejects malformed continuity', () => {
    const projector = new Alpha13AssistantStreamProjector()
    const baseline = projector.open(
      {
        revision: 1,
        activeAttempt: {
          attemptId: 'attempt-1',
          startedAfterSeq: 0,
          turn: 1,
          step: 1,
          nextIndex: 2,
          stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [2], texts: ['a', 'b'] }],
        },
      },
      's1',
    )
    expect(baseline.map((output) => output.type === 'chunk' && output.chunk)).toEqual([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
    ])

    const durable = {
      type: 'assistant/message',
      seq: 7,
      time: 103,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: {} },
      sessionId: 's1',
    }
    expect(projector.acceptDurable(durable)).toEqual([])
    expect(() =>
      projector.acceptFrame(
        {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 4,
          index: 2,
          time: 104,
          chunk: { type: 'text-delta', index: 0, text: 'c' },
        },
        's1',
      ),
    ).toThrow(/skipped revision/u)

    expect(() =>
      new Alpha13AssistantStreamProjector().open(
        {
          revision: 1,
          activeAttempt: {
            attemptId: 'attempt-1',
            startedAfterSeq: 0,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a', 'b'] }],
          },
        },
        's1',
      ),
    ).toThrow(/gaps/u)
  })

  it('reconstructs lossless raw records emitted by the compact stream accumulator', () => {
    const [output] = new Alpha13AssistantStreamProjector().open(
      {
        revision: 1,
        activeAttempt: {
          attemptId: 'attempt-raw',
          startedAfterSeq: -1,
          turn: 1,
          step: 1,
          nextIndex: 1,
          stream: [{ type: 'chunk', time: 42, chunk: { type: 'text-delta', index: 0, text: 'raw' } }],
        },
      },
      's1',
    )

    expect(output).toMatchObject({
      type: 'chunk',
      attemptId: 'attempt-raw',
      index: 0,
      time: 42,
      chunk: { type: 'text-delta', index: 0, text: 'raw' },
    })
  })

  it('bounds idle durable duplicate suppression state', () => {
    const projector = new Alpha13AssistantStreamProjector()
    projector.open({ revision: 0 }, 's1')
    for (let sequence = 0; sequence < 5_000; sequence += 1) projector.rememberDurable({ seq: sequence })

    const published = (projector as unknown as { readonly publishedSequences: Set<number> })
      .publishedSequences
    expect(published.size).toBeLessThanOrEqual(4_096)
    expect(published.has(0)).toBe(false)
    expect(published.has(4_999)).toBe(true)
  })

  it('rejects a replacement revision one without dropping a pending settlement', () => {
    const projector = new Alpha13AssistantStreamProjector()
    projector.open({ revision: 0 }, 's1')
    projector.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-old',
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
      },
      's1',
    )
    const settlement = {
      type: 'assistant/message',
      seq: 7,
      time: 103,
      surfaceOp: 'append',
      sessionId: 's1',
      data: { turn: 1, step: 1, message: {} },
    }
    expect(projector.acceptDurable(settlement)).toEqual([])

    expect(() =>
      projector.acceptFrame(
        {
          type: 'start',
          attemptId: 'attempt-new',
          revision: 1,
          startedAfterSeq: -1,
          turn: 2,
          step: 1,
        },
        's1',
      ),
    ).toThrow(/skipped revision 2/u)

    expect(
      projector.acceptFrame(
        {
          type: 'end',
          attemptId: 'attempt-old',
          revision: 2,
          index: 0,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 7 },
        },
        's1',
      ),
    ).toMatchObject([{ type: 'event', event: { seq: 7 } }])
  })

  it('settles assistant attempts and handles abandoned attempts with strict pending checks', () => {
    const committed = new Alpha13AssistantStreamProjector()
    committed.open({ revision: 0 }, 's1')
    committed.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-tool',
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
      },
      's1',
    )
    const attemptSettlement = {
      type: 'assistant/attempt',
      seq: 8,
      time: 104,
      surfaceOp: 'append',
      sessionId: 's1',
      data: { turn: 1, step: 1, attempt: {} },
    }
    expect(committed.acceptDurable(attemptSettlement)).toEqual([])
    expect(
      committed.acceptFrame(
        {
          type: 'end',
          attemptId: 'attempt-tool',
          revision: 2,
          index: 0,
          outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 8 },
        },
        's1',
      ),
    ).toMatchObject([{ type: 'event', event: { type: 'assistant/attempt', seq: 8 } }])

    const abandoned = new Alpha13AssistantStreamProjector()
    abandoned.open({ revision: 0 }, 's1')
    abandoned.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-abandoned',
        revision: 1,
        startedAfterSeq: -1,
        turn: 2,
        step: 1,
      },
      's1',
    )
    expect(
      abandoned.acceptFrame(
        {
          type: 'end',
          attemptId: 'attempt-abandoned',
          revision: 2,
          index: 0,
          outcome: { kind: 'abandoned' },
        },
        's1',
      ),
    ).toEqual([
      {
        type: 'interrupted',
        sessionId: 's1',
        attemptId: 'attempt-abandoned',
        turn: 2,
        step: 1,
      },
    ])

    const pending = new Alpha13AssistantStreamProjector()
    pending.open({ revision: 0 }, 's1')
    pending.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-pending',
        revision: 1,
        startedAfterSeq: -1,
        turn: 3,
        step: 1,
      },
      's1',
    )
    expect(
      pending.acceptDurable({
        type: 'assistant/message',
        seq: 9,
        time: 105,
        surfaceOp: 'append',
        sessionId: 's1',
        data: { turn: 3, step: 1, message: {} },
      }),
    ).toEqual([])
    expect(() =>
      pending.acceptFrame(
        {
          type: 'end',
          attemptId: 'attempt-pending',
          revision: 2,
          index: 0,
          outcome: { kind: 'abandoned' },
        },
        's1',
      ),
    ).toThrow(/abandoned with a pending durable settlement/u)
  })

  it('keeps transient ordering across a durable event and a retry attempt', () => {
    const projector = new Alpha13AssistantStreamProjector()
    projector.open({ revision: 0 }, 's1')
    projector.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-first',
        revision: 1,
        startedAfterSeq: 0,
        turn: 1,
        step: 1,
      },
      's1',
    )

    const firstChunk = projector.acceptFrame(
      {
        type: 'chunk',
        attemptId: 'attempt-first',
        revision: 2,
        index: 0,
        time: 101,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      },
      's1',
    )
    expect(firstChunk).toMatchObject([{ type: 'chunk', transientSequence: 1, attemptId: 'attempt-first' }])

    expect(
      projector.acceptDurable({
        type: 'llm/retry',
        seq: 1,
        time: 102,
        surfaceOp: 'append',
        sessionId: 's1',
        data: { turn: 1, step: 1, retry: 1 },
      }),
    ).toMatchObject([{ type: 'event', event: { type: 'llm/retry', seq: 1 } }])
    expect(
      projector.acceptFrame(
        {
          type: 'end',
          attemptId: 'attempt-first',
          revision: 3,
          index: 1,
          outcome: { kind: 'abandoned' },
        },
        's1',
      ),
    ).toMatchObject([{ type: 'interrupted', attemptId: 'attempt-first' }])

    projector.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-retry',
        revision: 4,
        startedAfterSeq: 1,
        turn: 1,
        step: 1,
      },
      's1',
    )
    const retryChunk = projector.acceptFrame(
      {
        type: 'chunk',
        attemptId: 'attempt-retry',
        revision: 5,
        index: 0,
        time: 103,
        chunk: { type: 'text-delta', index: 0, text: 'retry attempt' },
      },
      's1',
    )
    expect(retryChunk).toMatchObject([{ type: 'chunk', transientSequence: 2, attemptId: 'attempt-retry' }])
  })

  it('expands compact tool chunks and rejects duplicate chunk indexes', () => {
    const projector = new Alpha13AssistantStreamProjector()
    expect(
      projector.open(
        {
          revision: 1,
          activeAttempt: {
            attemptId: 'attempt-tool',
            startedAfterSeq: -1,
            turn: 1,
            step: 1,
            nextIndex: 2,
            stream: [
              {
                type: 'tool-call-chunks',
                time0: 100,
                index: 2,
                dt: [3],
                id: 'call-1',
                name: 'read',
                args: ['{"', 'x'],
              },
            ],
          },
        },
        's1',
      ),
    ).toMatchObject([
      {
        type: 'chunk',
        index: 0,
        chunk: { type: 'tool-call-delta', id: 'call-1', name: 'read', argumentsDelta: '{"' },
      },
      {
        type: 'chunk',
        index: 1,
        chunk: { type: 'tool-call-delta', id: 'call-1', name: 'read', argumentsDelta: 'x' },
      },
    ])

    expect(() =>
      projector.acceptFrame(
        {
          type: 'chunk',
          attemptId: 'attempt-tool',
          revision: 2,
          index: 1,
          time: 104,
          chunk: { type: 'text-delta', index: 0, text: 'duplicate' },
        },
        's1',
      ),
    ).toThrow(/expected chunk index 2/u)
  })

  it('keeps visible transient sequence contiguous across hidden tool chunks', () => {
    const projector = new Alpha13AssistantStreamProjector()
    projector.open({ revision: 0 }, 's1')
    projector.acceptFrame(
      {
        type: 'start',
        attemptId: 'attempt-mixed',
        revision: 1,
        startedAfterSeq: -1,
        turn: 1,
        step: 1,
      },
      's1',
    )

    const hidden = projector.acceptFrame(
      {
        type: 'chunk',
        attemptId: 'attempt-mixed',
        revision: 2,
        index: 0,
        time: 100,
        chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '{' },
      },
      's1',
    )
    const text = projector.acceptFrame(
      {
        type: 'chunk',
        attemptId: 'attempt-mixed',
        revision: 3,
        index: 1,
        time: 101,
        chunk: { type: 'text-delta', index: 1, text: 'visible' },
      },
      's1',
    )
    const reasoning = projector.acceptFrame(
      {
        type: 'chunk',
        attemptId: 'attempt-mixed',
        revision: 4,
        index: 2,
        time: 102,
        chunk: { type: 'reasoning-delta', index: 2, text: 'thinking' },
      },
      's1',
    )

    expect(hidden).toMatchObject([{ type: 'chunk', transientSequence: 0, index: 0 }])
    expect(text).toMatchObject([{ type: 'chunk', transientSequence: 1, index: 1 }])
    expect(reasoning).toMatchObject([{ type: 'chunk', transientSequence: 2, index: 2 }])
  })

  it('tags command attachments as submittedAttachments images on the 0.1.3 wire', async () => {
    const commands: { readonly method: string; readonly params: unknown }[] = []
    await expect(
      new Rc6CommandRepository(commandTransport(commands), 'submittedAttachments').execute(
        'session-1',
        '/goal inspect',
        [{ uri: 'data:image/png;base64,AQ==', name: 'diagram.png', mimeType: 'image/png' }],
      ),
    ).resolves.toEqual({ kind: 'success', text: 'applied' })
    expect(commands).toEqual([
      {
        method: 'commands/execute',
        params: {
          agentId: 'session-1',
          line: '/goal inspect',
          submittedAttachments: [
            { type: 'image', mediaType: 'image/png', data: 'AQ==', name: 'diagram.png' },
          ],
        },
      },
    ])
  })

  it('sends 0.1.3 session-config commands the required empty submittedAttachments array', async () => {
    const commands: { readonly method: string; readonly params: unknown }[] = []
    await new Rc6SessionRepository(commandTransport(commands), undefined, undefined, {
      commandAttachmentWire: 'submittedAttachments',
    }).setConfiguration('session-1', {
      preset: '',
      toolMode: 'native',
      permissionPreset: 'read-only',
      planMode: true,
      model: { providerId: '', modelId: '' },
    })
    expect(commands).toEqual([
      {
        method: 'commands/execute',
        params: { agentId: 'session-1', line: '/permission read-only', submittedAttachments: [] },
      },
      {
        method: 'commands/execute',
        params: { agentId: 'session-1', line: '/plan', submittedAttachments: [] },
      },
    ])
  })

  it('maps the renamed directory attachments flag onto the composer capability', async () => {
    const commands: { readonly method: string; readonly params: unknown }[] = []
    const directory = [
      { name: 'goal', description: 'Set a goal', input: { hint: 'objective', attachments: true } },
      { name: 'plan', description: 'Toggle plan mode', input: { hint: '', attachments: false } },
    ]
    await expect(
      new Rc6CommandRepository(commandTransport(commands, directory), 'submittedAttachments').list(
        'session-1',
      ),
    ).resolves.toEqual([
      { name: 'goal', description: 'Set a goal', input: { hint: 'objective', images: true } },
      { name: 'plan', description: 'Toggle plan mode', input: { hint: '' } },
    ])
  })

  it('builds the 0.1.3 command surface with the inherited submittedAttachments wire', async () => {
    const bodies: Record<string, unknown>[] = []
    const adapter = new Alpha13VersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
        const body = JSON.parse(init.body) as {
          readonly rpcId: string
          readonly payload?: { readonly args?: { readonly line?: string } }
        }
        bodies.push(body)
        // A line outside the directory resolves to `undefined`, which the
        // Gateway can only carry as an ok envelope without a value.
        const result =
          body.payload?.args?.line === '/goal'
            ? {
                ok: true,
                value: { commandId: 'alpha13-command', result: { kind: 'success', text: 'applied' } },
              }
            : { ok: true }
        return Promise.resolve(
          new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }), {
            headers: { 'content-type': 'application/json' },
          }),
        )
      }),
    })
    const backend = await adapter.createBackend({
      endpoint,
      ownership: 'external',
      capabilities: { protocolVersion: 'alpha13', dshVersion: '0.1.3-alpha.1', features: new Set() },
    })

    await expect(backend.commands.execute('session-1', '/goal')).resolves.toEqual({
      kind: 'success',
      text: 'applied',
    })
    expect(bodies.find((body) => body.method === 'commands/execute')?.payload).toEqual({
      args: { agentId: 'session-1', line: '/goal', submittedAttachments: [] },
    })

    await expect(backend.commands.execute('session-1', '/dsh-badge')).resolves.toEqual({
      kind: 'unknown',
    })
    await backend.close()
  })
})
