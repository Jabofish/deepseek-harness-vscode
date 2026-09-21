import { describe, expect, it, vi } from 'vitest'

import type { BackendEvent, BackendEndpoint } from '@dsh-vscode/domain'

import { Alpha162VersionAdapter } from '../src/versions/alpha162/adapter.js'
import type { AlphaLoopbackApiClient, AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { DshStreamController } from '../src/stream-controller.js'
import { callRpc } from '../src/versions/rc6/rpc.js'

/**
 * Fixture authority: DSH tag `dsh-v0.1.6-alpha.2`, commit
 * `ddefc45fbc7f8e46dd73185e68295696d1297887`; the `SessionControlFrame` and
 * `SessionControlBaseline` declarations are in
 * `packages/api/session-controller/src/types.ts`, and `InboxWireState` is in
 * `packages/core/agent/src/types.ts`.
 */
class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  public closeCalls = 0
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
    this.closeCalls += 1
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

const adapterOptions = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
  webSocket: FakeWebSocket,
}

function adapter(): Alpha162VersionAdapter {
  return new Alpha162VersionAdapter(adapterOptions)
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
  throw new Error('the alpha mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`the alpha mux socket sent ${socket.sent.length} frames; expected ${count}`)
}

function inboxMessage(id: string, text: string, source: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  }
}

describe('DSH 0.1.6-alpha.2 Session-Control contract', () => {
  it('uses the exact identity and projects the Inbox baseline and incremental updates', async () => {
    expect(adapter()).toMatchObject({
      id: 'dsh-0.1.6-alpha.2',
      supportedVersion: '0.1.6-alpha.2',
      protocolVersion: 'alpha162',
      fallback: false,
    })

    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: {
          jobs: { 's-1': [] },
          projections: {
            's-1': {
              asOfSeq: 12,
              values: {
                inbox: {
                  'next-turn': [inboxMessage('m-queue', 'queued text', { kind: 'user', rpcId: 'req-1' })],
                  'next-step': [inboxMessage('m-steer', 'steering text', { kind: 'plugin', plugin: 'test' })],
                },
              },
            },
          },
        },
      }),
    )

    await expect(first).resolves.toMatchObject({
      value: { type: 'session/jobs', sessionId: 's-1', jobs: [] },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session/queue',
        sessionId: 's-1',
        items: [
          { id: 'm-queue', placement: 'queued', rpcId: 'req-1', message: { id: 'm-queue' } },
          { id: 'm-steer', placement: 'steering', message: { id: 'm-steer' } },
        ],
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/projection', sessionId: 's-1', key: 'inbox', seq: 12 },
    })

    socket.message(
      streamItem(socket, {
        type: 'projection',
        sessionId: 's-1',
        key: 'inbox',
        seq: 13,
        value: { 'next-turn': [], 'next-step': [inboxMessage('m-next', 'next step', { kind: 'user' })] },
      }),
    )
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/queue', items: [{ id: 'm-next', placement: 'steering' }] },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/projection', sessionId: 's-1', key: 'inbox', seq: 13 },
    })

    await transport.close()
  })

  it('rejects the alpha.1 queues baseline and malformed Inbox values fail closed', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { queues: {}, jobs: {}, projections: {} },
      }),
    )
    await expect(first).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const malformedTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformedStream = malformedTransport.openHostStream(new AbortController().signal)
    const malformedIterator = malformedStream[Symbol.asyncIterator]()
    const malformedFirst = malformedIterator.next()
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    malformedSocket.message(
      streamItem(malformedSocket, {
        type: 'projection',
        sessionId: 's-1',
        key: 'inbox',
        seq: 1,
        value: {
          'next-turn': [inboxMessage('duplicate', 'one', { kind: 'user' })],
          'next-step': [inboxMessage('duplicate', 'two', { kind: 'user' })],
        },
      }),
    )
    await expect(malformedFirst).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it('normalizes writer-held as a retryable backend-busy error', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: {
              ok: false,
              error: { code: 'session/writer-held', message: 'writer held', details: { sessionId: 's-1' } },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)

    await expect(callRpc(transport, 'session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      retryable: true,
      context: { rpcCode: 'writer-held' },
    })
    await transport.close()
  })

  it('cancels the logical control stream and closes the physical mux', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const cancellation = new AbortController()
    const iterator = transport.openHostStream(cancellation.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

    cancellation.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    await waitForSent(socket, 2)
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({ type: 'cancel' })

    await transport.close()
    expect(socket.closeCalls).toBe(1)
  })
})

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
}

it('uploads binary content to its receiving session and submits only the receipt', async () => {
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(bodyText(init)) as { rpcId: string; method: string }
    const value =
      body.method === 'fileUploads/upload'
        ? { receiptId: 'receipt-1', file: { attachmentId: 'file-1', name: 'report.pdf', bytes: 4 } }
        : { accepted: true }
    return Promise.resolve(
      new Response(
        JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
      ),
    )
  })
  const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)
  await callRpc(transport, 'session.prompt', {
    sessionId: 's1',
    mode: 'queue',
    content: [
      { type: 'text', text: 'Read the attachment' },
      { type: 'file-upload', data: 'JVBERg==', name: 'report.pdf' },
    ],
  })
  expect(fetch.mock.calls.map(([url]) => (url as URL).pathname)).toEqual([
    '/api/fileUploads/upload',
    '/api/session/prompt',
  ])
  const upload = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as { payload: unknown }
  expect(upload.payload).toEqual({
    args: { agentId: 's1', request: { data: 'JVBERg==', name: 'report.pdf' } },
  })
  const prompt = JSON.parse(bodyText(fetch.mock.calls[1]?.[1])) as { payload: unknown }
  expect(prompt.payload).toMatchObject({
    args: {
      request: {
        sessionId: 's1',
        content: [
          { type: 'text', text: 'Read the attachment' },
          { type: 'file', receiptId: 'receipt-1' },
        ],
      },
    },
  })
  await transport.close()
})

it.each([
  {},
  { receiptId: '', file: {} },
  { receiptId: 'r', file: { attachmentId: 'f', name: 'x', bytes: -1 } },
])('does not send a prompt after a malformed upload receipt %j', async (value) => {
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(bodyText(init)) as { rpcId: string }
    return Promise.resolve(
      new Response(
        JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
      ),
    )
  })
  const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)
  await expect(
    callRpc(transport, 'session.prompt', {
      sessionId: 's1',
      content: [{ type: 'file-upload', data: 'AA==', name: 'file.bin' }],
    }),
  ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  expect(fetch).toHaveBeenCalledTimes(1)
  await transport.close()
})

it.each(['cancel', 'timeout', 'close'] as const)(
  'stops the binary upload before prompt admission on %s',
  async (mode) => {
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const reason: unknown = init.signal?.reason
              reject(reason instanceof Error ? reason : new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    const transport = new Alpha162VersionAdapter({
      ...adapterOptions,
      requestTimeoutMs: 25,
      fetch,
    }).createTransport(endpoint)
    const cancellation = new AbortController()
    const request = callRpc(
      transport,
      'session.prompt',
      { sessionId: 's1', content: [{ type: 'file-upload', data: 'AA==', name: 'file.bin' }] },
      cancellation.signal,
    )
    const rejected = expect(request).rejects.toMatchObject({
      code: mode === 'cancel' ? 'REQUEST_CANCELLED' : 'BACKEND_UNREACHABLE',
    })
    if (mode === 'cancel') cancellation.abort()
    if (mode === 'close') await transport.close()
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    await transport.close()
  },
)

it('routes a user Cordis refusal through the exact Remote instead of the approval waterfall', async () => {
  FakeWebSocket.instances.length = 0
  const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(bodyText(init)) as { rpcId: string }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value: { accepted: true } },
        }),
      ),
    )
  })
  const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(
    endpoint,
  ) as AlphaLoopbackApiClient
  const events: BackendEvent[] = []
  const controller = new DshStreamController(transport, undefined, undefined, {
    streamSource: (signal) => transport.openEventStream(signal),
  })
  controller.subscribe((event) => events.push(event))
  try {
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/test-home' } }))
    socket.message(
      streamItem(socket, {
        type: 'emit',
        event: 'cordis/request-run',
        args: [
          {
            requestId: 'r1',
            agentId: 's1',
            pluginId: 'p1',
            packageId: 'v1',
            name: 'Test',
            purpose: 'Test',
            mode: 'start',
            requiresApproval: true,
          },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'permission.requested',
          request: expect.objectContaining({
            sessionId: 's1',
            rpcId: 'cordis-run:r1',
            options: [{ id: 'rejected', label: 'Reject', kind: 'deny' }],
          }) as unknown,
        }),
      )
    })
    expect(fetch).not.toHaveBeenCalled()
    await transport.respondEnvelope('cordis-run:r1', {
      ok: true,
      value: { sessionId: 's1', outcome: 'rejected' },
    })
    expect((fetch.mock.calls[0]?.[0] as URL).pathname).toBe('/api/dynamicCordisRunner/resolveRequestRun')
    expect(JSON.parse(bodyText(fetch.mock.calls[0]?.[1]))).toMatchObject({
      payload: {
        args: {
          requestId: 'r1',
          resolution: { ok: false, reason: 'rejected' },
        },
      },
    })
  } finally {
    await transport.close()
    await controller.close()
  }
})

it('reads authenticated change snapshots through fixed GET routes and preserves 404 absence', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })),
    )
    .mockResolvedValueOnce(new Response('Gone', { status: 404 }))
  const transport = new Alpha162VersionAdapter({
    ...adapterOptions,
    fetch,
    authCookie: () => 'session=test',
  }).createTransport(endpoint) as AlphaLoopbackApiClient
  try {
    expect(await transport.readChanges('summary', 's 1', 7)).toMatchObject({ turn: 1 })
    expect((fetch.mock.calls[0]?.[0] as URL).pathname).toBe('/api/changes.summary')
    expect((fetch.mock.calls[0]?.[0] as URL).searchParams.get('sessionId')).toBe('s 1')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Cookie: 'session=test' },
    })
    expect(await transport.readChanges('diff', 's 1', 7, 0)).toBeUndefined()
  } finally {
    await transport.close()
  }
})

it.each([
  ['network', 'BACKEND_UNREACHABLE'],
  ['body', 'BACKEND_UNREACHABLE'],
  ['json', 'PROTOCOL_ERROR'],
  ['http', 'PERMISSION_DENIED'],
] as const)('normalizes changes %s failures and releases the body', async (mode, code) => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (mode === 'body') controller.error(new Error('read failed'))
      else {
        controller.enqueue(new TextEncoder().encode('not json'))
        controller.close()
      }
    },
  })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
    if (mode === 'network') return Promise.reject(new TypeError('fetch failed'))
    return Promise.resolve(new Response(body, { status: mode === 'http' ? 403 : 200 }))
  })
  const transport = new Alpha162VersionAdapter({ ...adapterOptions, fetch }).createTransport(
    endpoint,
  ) as AlphaLoopbackApiClient
  try {
    await expect(transport.readChanges('summary', 's1', 1)).rejects.toMatchObject({ code })
    expect(body.locked).toBe(false)
  } finally {
    await transport.close()
  }
})

it.each(['cancel', 'timeout', 'close'] as const)(
  'normalizes changes %s during body reading',
  async (mode) => {
    let body: ReadableStream<Uint8Array> | undefined
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true })
        },
      })
      return Promise.resolve(new Response(body))
    })
    const transport = new Alpha162VersionAdapter({
      ...adapterOptions,
      fetch,
      requestTimeoutMs: 25,
    }).createTransport(endpoint) as AlphaLoopbackApiClient
    const abort = new AbortController()
    try {
      const request = transport.readChanges('diff', 's1', 1, 0, abort.signal)
      const rejected = expect(request).rejects.toMatchObject({
        code: mode === 'timeout' ? 'BACKEND_UNREACHABLE' : 'REQUEST_CANCELLED',
        ...(mode === 'timeout' ? { context: { timedOut: true } } : {}),
      })
      if (mode === 'cancel') abort.abort()
      if (mode === 'close') await transport.close()
      await rejected
      expect(body?.locked).toBe(false)
    } finally {
      await transport.close()
    }
  },
)
