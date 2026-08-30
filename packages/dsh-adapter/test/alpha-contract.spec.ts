import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import { AlphaEventSource } from '../src/versions/alpha/events.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { AlphaVersionAdapter } from '../src/versions/alpha/adapter.js'
import { callRpc } from '../src/versions/rc6/rpc.js'

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

function client(fetch: typeof globalThis.fetch, timeout = 1_000): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: timeout,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
  })
}

function response(init: RequestInit | undefined, value: unknown): Response {
  const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

describe('DSH 0.1.2-alpha.1 Connection/Gateway contract', () => {
  it('posts the alpha Connection envelope, `{args}` Remote payload, and Cookie only in the Host', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const transport = client(fetch)

    await expect(callRpc<{ items: unknown[] }>(transport, 'session.list', {})).resolves.toEqual({ items: [] })
    await expect(transport.remoteRequest('commands/list', { agentId: 's1' })).resolves.toEqual({
      ok: true,
      value: { items: [] },
    })

    const first = fetch.mock.calls[0]
    const firstBody = JSON.parse(bodyText(first?.[1])) as { payload: unknown }
    expect(first?.[0]).toMatchObject({ pathname: '/api/session/list' })
    expect(first?.[1]?.headers).toMatchObject({ Cookie: 'dsh_session=test-cookie' })
    expect(firstBody.payload).toEqual({ args: { _request: {} } })
    const second = fetch.mock.calls[1]
    expect(second?.[0]).toMatchObject({ pathname: '/api/commands/list' })
    expect(JSON.parse(bodyText(second?.[1]))).toMatchObject({ payload: { args: { agentId: 's1' } } })
  })

  it('keeps the alpha prompt requestId as the queue-correlation id', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { accepted: true })),
    )
    const transport = client(fetch)

    const result = await transport.request<{ readonly rpcId: string; readonly result: unknown }>(
      'session.prompt',
      { sessionId: 's1', mode: 'queue', content: [] },
    )
    const body = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly rpcId: string
      readonly payload: { readonly args: { readonly request: { readonly requestId: string } } }
    }

    expect(body.payload.args.request.requestId).toBe(result.rpcId)
    expect(body.rpcId).not.toBe(result.rpcId)
    await transport.close()
  })

  it('projects alpha list titles from the upstream cwd fallback without replacing explicit titles', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          items: [
            { sessionId: 's-cwd', updatedAt: 1, running: false, blank: false, cwd: '/workspace/demo' },
            { sessionId: 's-id', updatedAt: 2, running: false, blank: false },
            {
              sessionId: 's-title',
              updatedAt: 3,
              running: false,
              blank: false,
              cwd: '/workspace/ignored',
              title: 'Explicit title',
            },
            { sessionId: 's-blank', updatedAt: 4, running: false, blank: true, cwd: '/workspace/blank' },
          ],
        }),
      ),
    )

    await expect(
      callRpc<{
        readonly items: readonly { readonly sessionId: string; readonly title?: string }[]
      }>(client(fetch), 'session.list', {}),
    ).resolves.toMatchObject({
      items: [
        { sessionId: 's-cwd', title: 'demo' },
        { sessionId: 's-id', title: 's-id' },
        { sessionId: 's-title', title: 'Explicit title' },
        { sessionId: 's-blank', title: 'blank' },
      ],
    })
  })

  it('maps a Gateway stream snapshot and expands packed chunk rows without parsing rendered text', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket?.message(
      streamItem(socket, {
        type: 'snapshot',
        header: {},
        cursor: 2,
        records: [
          {
            type: 'chunks',
            event: {
              type: 'chunkrow/text-chunks',
              seq: 1,
              time: 10,
              data: { turn: 1, step: 1, index: 7, dt: [2], texts: ['a', 'b'] },
            },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 2, values: {} },
      }),
    )
    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: 'session/event',
        sessionId: 's1',
        event: {
          type: 'assistant/chunk',
          seq: 1,
          time: 10,
          data: { chunk: { type: 'text-delta', index: 7, text: 'a' } },
        },
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'session/event',
        event: {
          type: 'assistant/chunk',
          seq: 2,
          time: 12,
          data: { chunk: { type: 'text-delta', index: 7, text: 'b' } },
        },
      },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/subscribed', sessionId: 's1', lastSeq: 2 },
    })
    await iterator.return?.()
    await transport.close()
  })

  it('keeps history records in the legacy `{ event }` repository shape and preserves projections', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const resultPromise = transport.request<{
      events: readonly { readonly event: unknown }[]
      hasMore: boolean
      projections: unknown
    }>('session.history', { sessionId: 's1' })
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const opening = JSON.parse(socket?.sent[0] ?? '{}') as { readonly streamId?: string }
    socket?.message({
      type: 'item',
      streamId: opening.streamId,
      value: {
        type: 'snapshot',
        header: {},
        cursor: 4,
        records: [
          {
            type: 'event',
            event: { type: 'request/context', seq: 4, time: 100, data: { provider: 'p', model: 'm' } },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 4, values: { agentPreset: 'default' } },
      },
    })
    socket?.message({ type: 'end', streamId: opening.streamId })

    await expect(resultPromise).resolves.toMatchObject({
      result: {
        ok: true,
        value: {
          events: [
            {
              event: {
                type: 'request/context',
                seq: 4,
                time: 100,
                data: { provider: 'p', model: 'm' },
                sessionId: 's1',
              },
            },
          ],
          hasMore: false,
          projections: { asOfSeq: 4, values: { agentPreset: 'default' } },
        },
      },
    })
    await transport.close()
  })

  it('wraps paginated and zero-argument alpha Remote calls in the required args object', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/session/modelCatalog')
        return Promise.resolve(
          response(init, {
            default: { provider: 'p', model: 'm' },
            routableProviders: ['p'],
          }),
        )
      return Promise.resolve(
        response(init, {
          records: [],
          hasMore: false,
          projections: { asOfSeq: 3, values: {} },
        }),
      )
    })
    const transport = client(fetch)
    const history = transport.request('session.history', {
      sessionId: 's1',
      beforeSeq: 3,
      maxMessages: 10,
    })
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: string }
    socket.message({
      type: 'item',
      streamId: opening.streamId,
      value: {
        type: 'snapshot',
        header: {},
        cursor: 7,
        records: [],
        hasMore: true,
        projections: { asOfSeq: 7, values: {} },
      },
    })
    socket.message({ type: 'end', streamId: opening.streamId })

    await expect(history).resolves.toMatchObject({
      result: { ok: true, value: { events: [], hasMore: false } },
    })
    const pageBody = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly request: Record<string, unknown> } }
    }
    expect(pageBody.payload.args.request).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 7,
      beforeSeq: 3,
      maxMessages: 10,
    })

    await expect(transport.request('session.models', {})).resolves.toMatchObject({
      result: { ok: true, value: { current: { provider: 'p', model: 'm' }, routable: true } },
    })
    const catalogBody = JSON.parse(bodyText(fetch.mock.calls[1]?.[1])) as {
      readonly payload: { readonly args: Record<string, unknown> }
    }
    expect(catalogBody.payload.args).toEqual({})
    await transport.close()
  })

  it('projects alpha credential descriptions into the legacy repository envelope', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          DEEPSEEK_API_KEY: { configured: true, writable: true },
        }),
      ),
    )
    const transport = client(fetch)

    await expect(
      transport.request('credentials.describe', { refs: ['DEEPSEEK_API_KEY'] }),
    ).resolves.toMatchObject({
      result: {
        ok: true,
        value: {
          credentials: {
            DEEPSEEK_API_KEY: { configured: true, writable: true },
          },
        },
      },
    })
    const body = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly refs: string[] } }
    }
    expect(body.payload.args).toEqual({ refs: ['DEEPSEEK_API_KEY'] })
    await transport.close()
  })

  it('shares one physical mux socket while cancelling logical streams independently', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const signal = new AbortController().signal
    const first = transport.openSessionStream('s1', signal)[Symbol.asyncIterator]()
    const second = transport.openSessionStream('s2', signal)[Symbol.asyncIterator]()
    const firstNext = first.next()
    const secondNext = second.next()
    const socket = await waitForSocket()
    expect(FakeWebSocket.instances).toHaveLength(1)
    socket.open()
    await waitForSent(socket, 2)
    const openings = socket.sent.map((entry) => JSON.parse(entry) as { streamId: string; type: string })
    expect(openings).toHaveLength(2)
    expect(openings[0]?.type).toBe('open')
    expect(openings[1]?.type).toBe('open')
    expect(openings[0]?.streamId).not.toBe(openings[1]?.streamId)
    socket.message({
      type: 'item',
      streamId: openings[0]?.streamId,
      value: {
        type: 'event',
        event: { type: 'request/context', seq: 0, time: 1, data: {} },
      },
    })
    socket.message({
      type: 'item',
      streamId: openings[1]?.streamId,
      value: {
        type: 'event',
        event: { type: 'request/context', seq: 0, time: 1, data: {} },
      },
    })
    await expect(firstNext).resolves.toMatchObject({ done: false })
    await expect(secondNext).resolves.toMatchObject({ done: false })

    await first.return?.()
    expect(JSON.parse(socket.sent[2] ?? '{}')).toEqual({ type: 'cancel', streamId: openings[0]?.streamId })
    expect(socket.closeCalls).toBe(0)
    socket.message({ type: 'end', streamId: openings[1]?.streamId })
    await expect(second.next()).resolves.toMatchObject({ done: true })
    expect(socket.closeCalls).toBe(0)
    await transport.close()
    expect(socket.closeCalls).toBe(1)
  })

  it('round-trips a scoped alpha waterfall response through `$events/result`', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, undefined)),
    )
    const transport = client(fetch)
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'emit',
        event: 'api-session/activity',
        args: ['s1', 1_700_000_000_000],
      }),
    )
    await expect(next).resolves.toEqual({
      value: {
        type: 'host/session-activity',
        sessionId: 's1',
        updatedAt: 1_700_000_000_000,
      },
      done: false,
    })
    const waterfallNext = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'event-1',
        agentId: 's1',
        request: {
          type: 'spoofed',
          rpcId: 'spoofed',
          sessionId: 'spoofed',
          approvalId: 'spoofed',
          toolName: 'shell',
          reason: 'test',
        },
      }),
    )
    await expect(waterfallNext).resolves.toMatchObject({
      value: {
        type: 'approval/requested',
        rpcId: 'event-1',
        sessionId: 's1',
        approvalId: 'event-1',
      },
    })
    await expect(
      transport.respondEnvelope('event-1', { ok: true, value: { outcome: 'allowed-once' } }),
    ).resolves.toEqual({ accepted: true })
    const body = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as { payload: { args: unknown } }
    expect(body.payload.args).toEqual({
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'result', value: { outcome: 'allowed-once' } },
    })
    await iterator.return?.()
    await transport.close()
  })

  it('resolves a cancelled alpha waterfall event with the session that requested it', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, undefined)),
    )
    const transport = client(fetch)
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'emit',
        event: 'api-session/activity',
        args: ['s1', 1_700_000_000_000],
      }),
    )
    await expect(next).resolves.toMatchObject({ done: false })
    socket.message(
      streamItem(socket, {
        type: 'waterfall',
        event: 'approval/request',
        eventId: 'event-1',
        agentId: 's1',
        request: {
          type: 'spoofed',
          rpcId: 'spoofed',
          sessionId: 'spoofed',
          approvalId: 'spoofed',
          toolName: 'shell',
          reason: 'test',
        },
      }),
    )
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'approval/requested', sessionId: 's1', approvalId: 'event-1' },
    })
    socket.message(streamItem(socket, { type: 'cancel', eventId: 'event-1' }))
    // The cancel frame itself carries only the eventId; the resolved projection must
    // recover the session from the waterfall that opened the interaction so
    // replay bookkeeping can clear the matching pending request.
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'approval/resolved',
        sessionId: 's1',
        approvalId: 'event-1',
        outcome: 'cancelled',
      },
    })
    socket.message(
      streamItem(socket, {
        type: 'waterfall',
        event: 'user-questions/request',
        eventId: 'event-2',
        agentId: 's2',
        request: { type: 'spoofed', rpcId: 'spoofed', sessionId: 'spoofed', prompt: 'test' },
      }),
    )
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'question/requested', sessionId: 's2' },
    })
    socket.message(streamItem(socket, { type: 'cancel', eventId: 'event-2' }))
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'question/resolved',
        sessionId: 's2',
        questionRpcId: 'event-2',
        outcome: 'cancelled',
      },
    })
    await iterator.return?.()
    await transport.close()
  })

  it('releases the unread body of failed alpha RPC and export responses', async () => {
    FakeWebSocket.instances.length = 0
    let cancelCalls = 0
    const fetch = vi.fn(() => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1
        },
      })
      return Promise.resolve(new Response(body, { status: 503 }))
    })
    const transport = client(fetch)

    await expect(transport.request('session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      context: { method: 'session/list', status: 503 },
    })
    await expect(transport.downloadSessionLog('s1', false)).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      context: { method: 'session.export', status: 503 },
    })
    // An unconsumed fetch body pins its socket; both failed responses must be
    // released back to the pool.
    expect(cancelCalls).toBe(2)
    await transport.close()
  })

  it('rejects interaction responses that are not tied to a current alpha waterfall event', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, undefined)),
    )
    const transport = client(fetch)
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'emit',
        event: 'api-session/activity',
        args: ['s1', 1_700_000_000_000],
      }),
    )
    await expect(next).resolves.toMatchObject({ done: false })
    await expect(transport.respondEnvelope('not-pending', { ok: true, value: {} })).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
    })
    expect(fetch).not.toHaveBeenCalled()
    await iterator.return?.()
    await transport.close()
  })

  it('rejects malformed known alpha event arguments instead of projecting them', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, undefined))),
    )
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'emit',
        event: 'api-session/status',
        args: ['s1', 'running'],
      }),
    )

    await expect(next).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('fails on a valid but unsupported alpha waterfall event instead of dropping it', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, undefined))),
    )
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'waterfall',
        event: 'future/request',
        eventId: 'event-1',
        agentId: 's1',
        request: {},
      }),
    )

    await expect(next).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('uses the alpha session export route with its query and Host-owned Cookie', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response('zip-content', { status: 200 })),
    )
    const transport = client(fetch)

    const exported = await transport.downloadSessionLog('s1', true)

    expect(await exported.text()).toBe('zip-content')
    expect(fetch).toHaveBeenCalledOnce()
    const [input, init] = fetch.mock.calls[0] ?? []
    expect(input).toMatchObject({
      pathname: '/api/session.export',
      search: '?sessionId=s1&includeDescendants=true',
    })
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { Cookie: 'dsh_session=test-cookie' },
    })
    await transport.close()
  })

  it('retries alpha reads but never retries a mutation after a transport failure', async () => {
    let attempts = 0
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/session/list') {
        attempts += 1
        if (attempts === 1) return Promise.reject(new Error('connection reset'))
        return Promise.resolve(response(init, { items: [] }))
      }
      return Promise.reject(new Error('connection reset'))
    })
    const transport = new AlphaLoopbackApiClient({
      endpoint,
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 2, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch,
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
    })

    await expect(callRpc<{ items: unknown[] }>(transport, 'session.list', {})).resolves.toEqual({ items: [] })
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(
      transport.request('session.rename', { sessionId: 's1', title: 'new' }),
    ).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    await transport.close()
  })

  it('fails closed on a malformed alpha server envelope', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('{bad', { headers: { 'content-type': 'application/json' } })),
    )
    await expect(client(fetch).request('session.list', {})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('maps alpha business errors through the stable application error contract', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: body.rpcId,
            result: {
              ok: false,
              error: {
                code: 'model-unavailable',
                message: 'provider token=should-not-cross-boundary',
                details: {},
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    await expect(callRpc(client(fetch), 'session.list', {})).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { rpcCode: 'model-unavailable' },
    })
  })
})

function streamItem(socket: FakeWebSocket, value: unknown): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: unknown }
  return { type: 'item', streamId: opening.streamId, value }
}

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
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

async function waitForEvent(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the expected alpha event was not observed')
}

describe('alpha remote mux receive queue', () => {
  it('fails a logical stream that buffers past the receive queue limit', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, undefined))),
    )
    const stream = transport.openSessionStream('s1', new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    // A session/follow stream opens directly with its snapshot; there is no
    // ready handshake on this logical stream.
    socket.message(
      streamItem(socket, {
        type: 'snapshot',
        header: {},
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
      }),
    )
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { type: 'session/subscribed', lastSeq: 0 },
    })

    // The stream consumer awaits inside its read loop (history recovery on a
    // seq gap), so the host can keep pushing mid-turn delta frames while the
    // generator is suspended at its yield. Without a bound the queue grows
    // for the whole suspension; the rc6 transport fails the stream instead.
    for (let index = 1; index <= 300; index += 1)
      socket.message(
        streamItem(socket, {
          type: 'event',
          event: { type: 'turn/start', seq: index, time: index, data: { turn: 1 } },
        }),
      )
    await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', retryable: true })
    await transport.close()
  })
})

describe('alpha backend assembly baseline ownership', () => {
  it('keeps control-stream jobs and queue baselines across a session follow subscription', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new AlphaVersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
    })
    const backend = await adapter.createBackend({
      endpoint,
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha1',
        dshVersion: '0.1.2-alpha.1',
        features: new Set(['events']),
      },
    })
    const received: BackendEvent[] = []
    const unsubscribe = backend.events.subscribe((event) => received.push(event))
    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForSent(socket, 3)
      const openStreamId = (streamEndpoint: string): number => {
        for (const sent of socket.sent) {
          const frame = JSON.parse(sent) as { type?: string; endpoint?: string; streamId?: number }
          if (frame.type === 'open' && frame.endpoint === streamEndpoint) return frame.streamId as number
        }
        throw new Error(`the alpha mux never opened ${streamEndpoint}`)
      }
      socket.message({
        type: 'item',
        streamId: openStreamId('$events'),
        value: { type: 'ready', clientId: 'client-1', host: { home: '/home/tester' } },
      })
      socket.message({
        type: 'item',
        streamId: openStreamId('workspace/follow'),
        value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
      })
      socket.message({
        type: 'item',
        streamId: openStreamId('session/control'),
        value: {
          type: 'baseline',
          value: {
            queues: { s1: [{ id: 'q1', placement: 'queued', message: { text: 'queued prompt' } }] },
            jobs: { s1: [{ id: 'j1', kind: 'build', label: 'build', status: 'running', startedAt: 1 }] },
            projections: {},
          },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'jobs.updated'))
      await expect(backend.jobs.list('s1')).resolves.toHaveLength(1)
      await expect(backend.sessions.listQueue('s1')).resolves.toHaveLength(1)

      ;(backend.events as AlphaEventSource).watchSession('s1')
      await waitForSent(socket, 4)
      socket.message({
        type: 'item',
        streamId: openStreamId('session/follow'),
        value: {
          type: 'snapshot',
          header: {},
          cursor: 5,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 5, values: {} },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'session.subscribed'))
      // The alpha session/follow snapshot carries no jobs or queue baseline;
      // the session/control stream owns that state, so re-subscribing a
      // session must not wipe what the control stream baselined.
      await expect(backend.jobs.list('s1')).resolves.toHaveLength(1)
      await expect(backend.sessions.listQueue('s1')).resolves.toHaveLength(1)
    } finally {
      unsubscribe()
      await backend.close()
    }
  })

  it('keeps a pending approval answerable across a session follow re-subscription', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new AlphaVersionAdapter({
      requestTimeoutMs: 1_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(response(init, undefined)),
      ),
      authCookie: () => 'dsh_session=test-cookie',
      webSocket: FakeWebSocket,
    })
    const backend = await adapter.createBackend({
      endpoint,
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha1',
        dshVersion: '0.1.2-alpha.1',
        features: new Set(['events']),
      },
    })
    const received: BackendEvent[] = []
    const unsubscribe = backend.events.subscribe((event) => received.push(event))
    try {
      const socket = await waitForSocket()
      socket.open()
      await waitForSent(socket, 3)
      const openStreamId = (streamEndpoint: string): number => {
        for (const sent of socket.sent) {
          const frame = JSON.parse(sent) as { type?: string; endpoint?: string; streamId?: number }
          if (frame.type === 'open' && frame.endpoint === streamEndpoint) return frame.streamId as number
        }
        throw new Error(`the alpha mux never opened ${streamEndpoint}`)
      }
      socket.message({
        type: 'item',
        streamId: openStreamId('$events'),
        value: { type: 'ready', clientId: 'client-1', host: { home: '/home/tester' } },
      })
      socket.message({
        type: 'item',
        streamId: openStreamId('workspace/follow'),
        value: { type: 'baseline', value: { items: [], archivedSessionIds: [] } },
      })
      // A pending approval arrives through the $events waterfall while the
      // session has never been followed.
      socket.message({
        type: 'item',
        streamId: openStreamId('$events'),
        value: {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'evt-1',
          agentId: 's1',
          request: { toolName: 'shell', reason: 'needs approval' },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'permission.requested'))

      ;(backend.events as AlphaEventSource).watchSession('s1')
      await waitForSent(socket, 4)
      socket.message({
        type: 'item',
        streamId: openStreamId('session/follow'),
        value: {
          type: 'snapshot',
          header: {},
          cursor: 5,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 5, values: {} },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'session.subscribed'))
      // Alpha delivers approvals as $events waterfalls; a session/follow
      // subscription replays nothing, so the pending answer must survive it.
      await expect(backend.interactions.respondToPermission('evt-1', 'allowed-once')).resolves.toBeUndefined()
    } finally {
      unsubscribe()
      await backend.close()
    }
  })
})
