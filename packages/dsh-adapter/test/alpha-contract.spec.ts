import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint, BackendEvent } from '@dsh-vscode/domain'

import type { AlphaEventSource } from '../src/versions/alpha/events.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { Alpha1VersionAdapter } from '../src/versions/alpha/adapter.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { Rc6CredentialRepository } from '../src/repositories/credential-repository.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { Rc6SubagentRepository } from '../src/repositories/subagent-repository.js'
import { SubagentAddressRegistry } from '../src/repositories/shared/subagent-addresses.js'

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

function client(
  fetch: typeof globalThis.fetch,
  timeout = 1_000,
  subagentAddresses?: SubagentAddressRegistry,
  sessionHistoryTurnWindow = false,
): AlphaLoopbackApiClient {
  return new AlphaLoopbackApiClient({
    endpoint,
    requestTimeoutMs: timeout,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
    sessionHistoryTurnWindow,
    ...(subagentAddresses === undefined ? {} : { subagentAddresses }),
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

  it('keeps an absent Remote value absent instead of inventing an empty object', async () => {
    // The Gateway drops the `value` member for a Remote method that returned
    // `undefined`. Rewriting that envelope to `value: {}` would erase the
    // difference between "no result" and an empty one, so the absence has to
    // survive to the caller that declared it.
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
      return Promise.resolve(
        new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    })

    await expect(client(fetch).remoteRequest('commands/execute', { agentId: 's1' })).resolves.toEqual({
      ok: true,
    })
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

  it('joins the live provider list with the dormant configurable provider catalog', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/llm/listProviders')
        return Promise.resolve(response(init, [{ id: 'deepseek-official', name: 'DeepSeek' }]))
      if (pathname === '/api/llm/listConfigurableProviders')
        return Promise.resolve(
          response(init, [
            {
              provider: 'deepseek-official',
              displayName: 'DeepSeek',
              settingsNs: 'llm-deepseek',
              settingsPath: [],
              declared: true,
            },
            {
              provider: 'openai',
              displayName: 'OpenAI',
              settingsNs: 'llm-pi-ai',
              settingsPath: ['providers', 'openai'],
              declared: false,
            },
          ]),
        )
      return Promise.reject(new Error(`unexpected alpha endpoint ${pathname}`))
    })
    const transport = client(fetch)

    await expect(
      callRpc<{
        readonly providers: readonly Record<string, unknown>[]
      }>(transport, 'llm.providers', {}),
    ).resolves.toEqual({
      providers: [
        {
          provider: 'deepseek-official',
          displayName: 'DeepSeek',
          settingsNs: 'llm-deepseek',
          settingsPath: [],
          active: true,
          declared: true,
        },
        {
          provider: 'openai',
          displayName: 'OpenAI',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'openai'],
          active: false,
          declared: false,
        },
      ],
    })
    await transport.close()
  })

  it('keeps a live-only provider addressless instead of fabricating a settings namespace', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/llm/listProviders')
        return Promise.resolve(response(init, [{ id: 'runtime-only', name: 'Runtime only' }]))
      if (pathname === '/api/llm/listConfigurableProviders') return Promise.resolve(response(init, []))
      return Promise.reject(new Error(`unexpected alpha endpoint ${pathname}`))
    })
    const transport = client(fetch)

    await expect(
      callRpc<{ readonly providers: readonly Record<string, unknown>[] }>(transport, 'llm.providers', {}),
    ).resolves.toEqual({
      providers: [
        {
          provider: 'runtime-only',
          displayName: 'Runtime only',
          settingsNs: '',
          settingsPath: [],
          active: true,
        },
      ],
    })
    await transport.close()
  })

  it.each([
    ['a non-array live provider result', {}, []],
    ['a malformed live provider entry', [{}], []],
    ['a non-array configurable provider result', [], {}],
    ['a malformed configurable provider entry', [], [{}]],
  ])('fails closed for %s instead of silently hiding provider state', async (_label, listed, configs) => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/llm/listProviders') return Promise.resolve(response(init, listed))
      if (pathname === '/api/llm/listConfigurableProviders') return Promise.resolve(response(init, configs))
      return Promise.reject(new Error(`unexpected alpha endpoint ${pathname}`))
    })
    const transport = client(fetch)

    await expect(callRpc(transport, 'llm.providers', {})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
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

  it('keeps live canonical goal changes lossless instead of turning malformed changes into clears', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
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
      value: { type: 'session/subscribed', sessionId: 's1', lastSeq: 0 },
    })

    const next = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'event',
        event: {
          type: 'goal/change',
          seq: 1,
          time: 1,
          data: {
            kind: 'goal/change',
            version: 1,
            operation: 'edit',
          },
        },
      }),
    )
    await expect(next).resolves.toMatchObject({
      value: {
        type: 'session/event',
        event: {
          type: 'goal/change',
          data: { kind: 'goal/change', version: 1, operation: 'edit' },
        },
      },
    })
    await iterator.return?.()
    await transport.close()
  })

  it('orders mixed snapshot records by durable sequence before exposing the session stream', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'snapshot',
        header: {},
        cursor: 3,
        // The server may interleave a later event and an expanded chunk row.
        // The logical stream must still expose 1, 2, 3 so its sequence
        // watermark cannot discard the earlier conversation records.
        records: [
          {
            type: 'event',
            event: { type: 'future/telemetry', seq: 3, time: 30, data: {}, ignorable: true },
          },
          {
            type: 'chunks',
            event: {
              type: 'chunkrow/text-chunks',
              seq: 1,
              time: 10,
              data: { turn: 1, step: 1, index: 7, dt: [1], texts: ['a', 'b'] },
            },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 3, values: {} },
      }),
    )

    await expect(first).resolves.toMatchObject({
      value: { type: 'session/event', event: { seq: 1, type: 'assistant/chunk' } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/event', event: { seq: 2, type: 'assistant/chunk' } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/event', event: { seq: 3, type: 'future/telemetry' } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/subscribed', sessionId: 's1', lastSeq: 3 },
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

  it('forwards turn windows on both follow snapshots and older pages for supported versions', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { records: [], hasMore: false })),
    )
    const transport = client(fetch, 1_000, undefined, true)
    const history = transport.request('session.history', {
      sessionId: 's1',
      beforeSeq: 42,
      maxMessages: 500,
      turnWindow: { minMessages: 200, minTurns: 2 },
    })
    const socket = await waitForSocket()
    socket.open()
    await answerFollow(socket, 1, {
      type: 'snapshot',
      header: {},
      cursor: 70,
      records: [],
      hasMore: true,
      projections: { asOfSeq: 70, values: {} },
    })

    await expect(history).resolves.toMatchObject({ result: { ok: true, value: { hasMore: false } } })
    const followOpen = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly endpoint?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(followOpen.endpoint).toBe('session/follow')
    expect(followOpen.payload?.args?.request).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      maxMessages: 500,
      turnWindow: { minMessages: 200, minTurns: 2 },
    })
    const page = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly request: Record<string, unknown> } }
    }
    expect(page.payload.args.request).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 70,
      beforeSeq: 42,
      maxMessages: 500,
      turnWindow: { minMessages: 200, minTurns: 2 },
    })
    await transport.close()
  })

  it('drops turn windows for profiles that do not declare support', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { records: [], hasMore: false })),
    )
    const transport = client(fetch)
    const history = transport.request('session.history', {
      sessionId: 's1',
      beforeSeq: 42,
      maxMessages: 77,
      turnWindow: { minMessages: 50, minTurns: 2 },
    })
    const socket = await waitForSocket()
    socket.open()
    await answerFollow(socket, 1, {
      type: 'snapshot',
      header: {},
      cursor: 70,
      records: [],
      hasMore: true,
      projections: { asOfSeq: 70, values: {} },
    })

    await history
    const followOpen = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(followOpen.payload?.args?.request).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      maxMessages: 77,
    })
    const page = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly request: Record<string, unknown> } }
    }
    expect(page.payload.args.request).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 70,
      beforeSeq: 42,
      maxMessages: 77,
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
    await answerFollow(socket, 1, {
      type: 'snapshot',
      header: {},
      cursor: 7,
      records: [],
      hasMore: true,
      projections: { asOfSeq: 7, values: {} },
    })

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

    // The session directory is the zero-argument exception on the post side: it
    // reads the session's own route over a second logical stream of the mux.
    const models = transport.request('session.models', { sessionId: 's1' })
    await answerFollow(socket, 2, {
      type: 'snapshot',
      header: {},
      cursor: 2,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 2, values: {} },
    })
    const modelsOpen = JSON.parse(socket.sent[1] ?? '{}') as {
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(modelsOpen.payload?.args?.request).toMatchObject({
      address: { kind: 'session', sessionId: 's1' },
    })

    await expect(models).resolves.toMatchObject({
      result: { ok: true, value: { current: { provider: 'p', model: 'm' }, routable: true } },
    })
    const catalogBody = JSON.parse(bodyText(fetch.mock.calls[1]?.[1])) as {
      readonly payload: { readonly args: Record<string, unknown> }
    }
    expect(catalogBody.payload.args).toEqual({})
    await transport.close()
  })

  it.each([
    [
      'the route this session selected even though the default provider is gone',
      { provider: 'retired', model: 'x' },
      ['served'],
      {
        lastUsed: { provider: 'served', model: 'y' },
        next: { provider: 'served', model: 'y', reasoningEffort: 'high' },
      },
      { provider: 'served', model: 'y', reasoningEffort: 'high' },
      true,
    ],
    [
      'the route the latest request used even though its adapter is gone',
      { provider: 'served', model: 'y' },
      ['served'],
      { lastUsed: { provider: 'retired', model: 'x' }, next: null },
      { provider: 'retired', model: 'x' },
      false,
    ],
  ])(
    'states %s instead of restating the deployment default',
    async (_label, defaultSelection, routableProviders, modelSelection, current, routable) => {
      // The catalog answers the deployment default and every routable provider,
      // never which route *this* session uses — that is durable session state.
      // Answering the default under the name of the session's route would block
      // a session whose own adapter is serving it and let through one whose
      // adapter is gone; the routing verdict has to follow the same selection.
      FakeWebSocket.instances.length = 0
      const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        Promise.resolve(
          response(init, { default: defaultSelection, routableProviders, groups: [], failures: [] }),
        ),
      )
      const transport = client(fetch)
      const models = transport.request('session.models', { sessionId: 's1' })
      const socket = await waitForSocket()
      socket.open()
      await answerFollow(socket, 1, {
        type: 'snapshot',
        header: {},
        cursor: 2,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 2, values: { modelSelection } },
      })

      await expect(models).resolves.toMatchObject({ result: { ok: true, value: { current, routable } } })
      await transport.close()
    },
  )

  it('keeps the catalog default whole for a session that never selected a model', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          default: { provider: 'p', model: 'm', reasoningEffort: 'low' },
          routableProviders: ['p'],
        }),
      ),
    )
    const transport = client(fetch)

    const models = transport.request('session.models', { sessionId: 's1' })
    const socket = await waitForSocket()
    socket.open()
    await answerFollow(socket, 1, {
      type: 'snapshot',
      header: {},
      cursor: 0,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 0, values: { modelSelection: { lastUsed: null, next: null } } },
    })

    await expect(models).resolves.toMatchObject({
      result: {
        ok: true,
        value: { current: { provider: 'p', model: 'm', reasoningEffort: 'low' }, routable: true },
      },
    })
    await transport.close()
  })

  it('fails the session directory instead of answering a default it could not check', async () => {
    // The projection read is not optional: a baseline that never arrives leaves
    // the read unable to tell the session's route from the default, and a
    // verdict guessed from the default is exactly the misstatement above.
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { default: { provider: 'p', model: 'm' }, routableProviders: ['p'] })),
    )
    const transport = client(fetch)

    const models = transport.request('session.models', { sessionId: 's1' })
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: string }
    socket.message({ type: 'end', streamId: opening.streamId })

    await expect(models).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('addresses a catalog-resolved child session by its durable subagent descriptor', async () => {
    // The host refuses a session-kind address whose Session header is
    // subagent-origin (`session/agent-busy`, "use subagent delivery for this
    // child session"). Every session-addressed read the client performs for a
    // child — the live follow stream and the history snapshot/page pair — has
    // to carry the descriptor the catalog published instead.
    FakeWebSocket.instances.length = 0
    const subagentAddresses = new SubagentAddressRegistry()
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      if (pathname === '/api/subagents/list')
        return Promise.resolve(
          response(init, {
            entries: [
              {
                kind: 'child',
                id: 'child-1',
                activity: 'inactive',
                hasChildren: false,
                mode: 'continuable',
                label: 'Child',
              },
            ],
            parentAvailable: true,
          }),
        )
      return Promise.resolve(response(init, { records: [], hasMore: false }))
    })
    const transport = client(fetch, 1_000, subagentAddresses)
    const subagents = new Rc6SubagentRepository(transport, { addresses: subagentAddresses })
    await expect(subagents.list('parent-1')).resolves.toMatchObject({ parentAvailable: true })

    const snapshot = new Rc6SessionRepository(transport).history('child-1', 1, undefined, {
      pageSize: 200,
      pagePurpose: 'gap-recovery',
    })
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const followOpen = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly streamId?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(followOpen.payload?.args?.request).toMatchObject({
      address: {
        kind: 'subagent',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        mode: 'continuable',
      },
      maxMessages: 200,
    })
    expect(followOpen.payload?.args?.request).not.toHaveProperty('turnWindow')
    socket.message(
      streamItem(
        socket,
        {
          type: 'snapshot',
          header: {},
          cursor: 1,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 1, values: {} },
        },
        followOpen.streamId,
      ),
    )
    socket.message({ type: 'end', streamId: followOpen.streamId })
    await snapshot
    const pageCall = fetch.mock.calls[1]
    const pageBody = JSON.parse(bodyText(pageCall?.[1])) as {
      readonly payload: { readonly args: { readonly request: Record<string, unknown> } }
    }
    expect(pageCall?.[0]).toMatchObject({ pathname: '/api/session/page' })
    expect(pageBody.payload.args.request).toEqual({
      address: {
        kind: 'subagent',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        mode: 'continuable',
      },
      throughSeq: 1,
      beforeSeq: 1,
      maxMessages: 200,
    })

    const live = transport.openSessionStream('child-1', new AbortController().signal)[Symbol.asyncIterator]()
    const liveNext = live.next()
    await waitForSent(socket, 2)
    const liveOpen = JSON.parse(socket.sent[1] ?? '{}') as {
      readonly streamId?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(liveOpen.payload?.args?.request).toMatchObject({
      address: {
        kind: 'subagent',
        parentSessionId: 'parent-1',
        childSessionId: 'child-1',
        mode: 'continuable',
      },
    })
    socket.message({ type: 'end', streamId: liveOpen.streamId })
    await liveNext

    // A Session the catalog never described keeps the ordinary address.
    const plain = transport.request('session.history', { sessionId: 'child-2', maxMessages: 50 })
    await waitForSent(socket, 3)
    const plainOpen = JSON.parse(socket.sent[2] ?? '{}') as {
      readonly streamId?: string
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    expect(plainOpen.payload?.args?.request).toMatchObject({
      address: { kind: 'session', sessionId: 'child-2' },
    })
    socket.message(
      streamItem(
        socket,
        {
          type: 'snapshot',
          header: {},
          cursor: 1,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 1, values: {} },
        },
        plainOpen.streamId,
      ),
    )
    socket.message({ type: 'end', streamId: plainOpen.streamId })
    await plain
    await transport.close()
  })

  it('pages a subagent transcript through the child address instead of the session log', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          records: [
            {
              type: 'event',
              event: { type: 'request/context', seq: 3, time: 100, data: { provider: 'p', model: 'm' } },
            },
          ],
          hasMore: true,
          projections: { asOfSeq: 7, values: {} },
        }),
      ),
    )
    const transport = client(fetch)

    const history = transport.request('subagent.history', {
      parentSessionId: 'parent',
      childSessionId: 'child',
      mode: 'continuable',
      maxMessages: 50,
      beforeSeq: 4,
    })
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: string }
    socket.message(
      streamItem(socket, {
        type: 'snapshot',
        header: {},
        cursor: 7,
        records: [],
        hasMore: true,
        projections: { asOfSeq: 7, values: {} },
      }),
    )
    socket.message({ type: 'end', streamId: opening.streamId })

    await expect(history).resolves.toMatchObject({
      result: { ok: true, value: { events: [{ event: { seq: 3 } }], hasMore: true } },
    })
    const pageBody = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly request: Record<string, unknown> } }
    }
    // `session/page` is addressed by the same child descriptor the follow
    // stream used; falling back to the session address would page the parent
    // log while the drawer shows the child transcript.
    expect(pageBody.payload.args.request).toEqual({
      address: {
        kind: 'subagent',
        parentSessionId: 'parent',
        childSessionId: 'child',
        mode: 'continuable',
      },
      throughSeq: 7,
      beforeSeq: 4,
      maxMessages: 50,
    })
    await transport.close()
  })

  it('restores an archived session through the alpha unarchive route', async () => {
    const requests: { readonly pathname: string; readonly body: Record<string, unknown> }[] = []
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname =
        input instanceof URL
          ? input.pathname
          : new URL(typeof input === 'string' ? input : input.url).pathname
      requests.push({ pathname, body: JSON.parse(bodyText(init)) as Record<string, unknown> })
      return Promise.resolve(response(init, { archivedSessionIds: ['s2'] }))
    })
    const transport = client(fetch)

    await expect(transport.request('workspace.unarchiveSession', { sessionId: 's1' })).resolves.toMatchObject(
      { result: { ok: true, value: { archivedSessionIds: ['s2'] } } },
    )

    // The restore is its own alpha Remote method, not a flag on the archive
    // one, and it answers the complete archive set this registry now holds.
    expect(requests).toHaveLength(1)
    expect(requests[0]?.pathname).toBe('/api/workspace/unarchiveSession')
    expect(requests[0]?.body).toMatchObject({
      method: 'workspace/unarchiveSession',
      payload: { args: { request: { sessionId: 's1' } } },
    })
    await transport.close()
  })

  it('normalizes and validates alpha goal mutation receipts at the version boundary', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ref: { id: 'goal-1', revision: 2 } })),
    )
    const transport = client(fetch)

    await expect(
      transport.request('goal.create', { sessionId: 's1', objective: 'bounded work' }),
    ).resolves.toMatchObject({ result: { ok: true, value: { ref: { id: 'goal-1', revision: 2 } } } })
    await expect(
      transport.request('goal.edit', {
        sessionId: 's1',
        ref: { id: 'goal-1', revision: 1 },
        objective: 'updated work',
      }),
    ).resolves.toMatchObject({ result: { ok: true, value: { ref: { id: 'goal-1', revision: 2 } } } })

    await transport.close()

    const malformedFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ref: { id: 'goal-1', revision: 0 } })),
    )
    const malformedTransport = client(malformedFetch)
    await expect(
      malformedTransport.request('goal.create', { sessionId: 's1', objective: 'bounded work' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it.each([
    [{ default: { provider: 'p', model: 'm' } }],
    [{ default: { provider: 'p', model: 'm' }, routableProviders: 'p' }],
    [{ default: { provider: 'p', model: 'm' }, routableProviders: [1] }],
  ])('fails closed when the alpha model catalog omits or corrupts routableProviders', async (catalog) => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, catalog)),
    )
    const transport = client(fetch)

    await expect(transport.request('session.models', { sessionId: 's1' })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await transport.close()

    const secondTransport = client(fetch)
    await expect(secondTransport.request('llm.models', {})).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await secondTransport.close()
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

  it('projects the void credentials receipt into the legacy empty receipt', async () => {
    // The alpha credentials Remote declares `RemoteResult<void>`, so the
    // Gateway answers `{ok: true}` with no `value` member at all. The legacy
    // repository contract reads a credential write receipt as an empty object,
    // and the version transport owns that projection.
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly rpcId: string }
      return Promise.resolve(
        new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    })
    const transport = client(fetch)
    const credentials = new Rc6CredentialRepository(transport)

    await expect(credentials.setReference('DEEPSEEK_API_KEY', 'sk-test-value')).resolves.toBeUndefined()
    await expect(credentials.unsetReference('DEEPSEEK_API_KEY')).resolves.toBeUndefined()

    expect(fetch.mock.calls.map((call) => call[0])).toMatchObject([
      { pathname: '/api/credentials/set' },
      { pathname: '/api/credentials/unset' },
    ])
    const setBody = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly ref: string; readonly value: string } }
    }
    expect(setBody.payload.args).toEqual({ ref: 'DEEPSEEK_API_KEY', value: 'sk-test-value' })
    await transport.close()
  })

  it('keeps a refused credentials receipt an error instead of an empty success', async () => {
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
                code: 'credential-rejected',
                message: 'the reference is shadowed by a read-only layer',
                details: { ref: 'DEEPSEEK_API_KEY' },
              },
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      )
    })
    const transport = client(fetch)
    const credentials = new Rc6CredentialRepository(transport)

    await expect(credentials.setReference('DEEPSEEK_API_KEY', 'sk-test-value')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
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
      transport.respondEnvelope('event-1', {
        ok: true,
        value: { sessionId: 's1', approvalId: 'event-1', outcome: 'allowed-once' },
      }),
    ).resolves.toEqual({ accepted: true })
    const body = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as { payload: { args: unknown } }
    expect(body.payload.args).toEqual({
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'result', value: 'allowed-once' },
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

  it('rejects an api-session/added event that omits the required blank bit', async () => {
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
        event: 'api-session/added',
        args: [{ sessionId: 's1' }],
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

  it('streams the session export past the request budget the RPC carrier uses', async () => {
    // The archive grows with the session, so the Host can still be deflating a
    // large one when an ordinary RPC round trip would already have timed out.
    // Applying that budget here reports a failure for an export the Host
    // completes, and the partial ZIP is what the user sees.
    let aborted = false
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('zip-content', { status: 200 })), 40)
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            clearTimeout(timer)
            const reason: unknown = init.signal?.reason
            reject(reason instanceof Error ? reason : new Error('The export download was aborted.'))
          })
        }),
    )
    const transport = client(fetch, 10)

    try {
      await expect(transport.downloadSessionLog('s1', false)).resolves.toBeInstanceOf(Response)
      expect(aborted).toBe(false)
    } finally {
      await transport.close()
    }
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

function streamItem(socket: FakeWebSocket, value: unknown, streamId?: string): unknown {
  const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: unknown }
  return { type: 'item', streamId: streamId ?? opening.streamId, value }
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

/**
 * Answer the `frame`th logical-stream opening on the mux socket with one
 * baseline snapshot and close it. A remote method that reads a session baseline
 * blocks until this frame arrives, so the answer has to name the stream the
 * transport opened for it.
 */
async function answerFollow(
  socket: FakeWebSocket,
  frame: number,
  value: Record<string, unknown>,
): Promise<void> {
  await waitForSent(socket, frame)
  const opening = JSON.parse(socket.sent[frame - 1] ?? '{}') as { readonly streamId?: string }
  socket.message(streamItem(socket, value, opening.streamId))
  socket.message({ type: 'end', streamId: opening.streamId })
}

async function waitForEvent(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the expected alpha event was not observed')
}

describe('alpha remote mux receive queue', () => {
  it('keeps a logical stream alive when its buffer passes the receive queue limit', async () => {
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

    // The stream consumer can await inside its read loop (history recovery on
    // a seq gap), so the host can keep pushing mid-turn delta frames while the
    // generator is suspended at its yield. The queue stays bounded, but
    // overflowing it drops only the buffered frames: failing the stream here
    // tore down the mux generation mid-answer and cascaded into reconnect
    // storms. The dropped range resurfaces as an ordinary sequence hole that
    // stream-controller gap detection heals from history.
    for (let index = 1; index <= 300; index += 1)
      socket.message(
        streamItem(socket, {
          type: 'event',
          event: { type: 'turn/start', seq: index, time: index, data: { turn: 1 } },
        }),
      )
    // The buffered frames beyond the bound were dropped, so the first frame
    // the consumer observes after resuming is a later one from the burst.
    const resumed = await iterator.next()
    expect(resumed).toMatchObject({ done: false, value: { type: 'session/event' } })
    expect((resumed.value as { readonly event?: { readonly seq?: number } }).event?.seq ?? 0).toBeGreaterThan(
      0,
    )
    // The stream itself survives the overflow; the next frame still arrives
    // instead of the previous PROTOCOL_ERROR teardown.
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'session/event' },
    })
    await transport.close()
  })

  it('normalizes an incremental control projection so it cannot occupy a durable sequence', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(response(init, undefined))),
    )
    const stream = transport.openHostStream(new AbortController().signal)
    const iterator = stream[Symbol.asyncIterator]()
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
    // Real DSH emits incremental projection frames whose `seq` is the cursor
    // they describe, not a durable log position. The next durable row can
    // carry the very same sequence, so the frame must reach the adapter as the
    // same non-durable `session/projection` shape the baseline branch produces.
    socket.message(
      streamItem(socket, {
        type: 'projection',
        sessionId: 's1',
        key: 'next-turn',
        value: [{ turn: 1, seq: 15 }],
        seq: 15,
      }),
    )
    await expect(first).resolves.toMatchObject({
      done: false,
      value: {
        type: 'session/projection',
        sessionId: 's1',
        key: 'next-turn',
        value: [{ turn: 1, seq: 15 }],
        seq: 15,
      },
    })
    await transport.close()
  })
})

describe('alpha backend assembly baseline ownership', () => {
  it('keeps control-stream jobs and queue baselines across a session follow subscription', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new Alpha1VersionAdapter({
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
            queues: {
              s1: [
                {
                  id: 'q1',
                  placement: 'queued',
                  message: {
                    id: 'message-q1',
                    role: 'user',
                    content: [{ type: 'text', text: 'queued prompt' }],
                    source: { kind: 'user' },
                  },
                  createdAt: 1,
                },
              ],
            },
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
      expect(received.find((event) => event.type === 'session.subscribed')).toMatchObject({
        controlBaseline: false,
      })
      // The alpha session/follow snapshot carries no jobs or queue baseline;
      // the session/control stream owns that state, so re-subscribing a
      // session must not wipe what the control stream baselined.
      await expect(backend.jobs.list('s1')).resolves.toHaveLength(1)
      await expect(backend.sessions.listQueue('s1')).resolves.toHaveLength(1)
      // A Session the control stream never named — the host broadcasts a queue
      // frame only when pending input changes, so a Session created after the
      // baseline stays unmentioned until its first enqueue. The reference client
      // materializes it as an empty queue, not as unreadable state.
      await expect(backend.sessions.listQueue('never-mentioned')).resolves.toEqual([])
    } finally {
      unsubscribe()
      await backend.close()
    }
  })

  it('keeps the durable completion that shares its sequence with a control projection', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new Alpha1VersionAdapter({
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
        value: { type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } },
      })
      ;(backend.events as AlphaEventSource).watchSession('s1')
      await waitForSent(socket, 4)
      socket.message({
        type: 'item',
        streamId: openStreamId('session/follow'),
        value: {
          type: 'snapshot',
          header: {},
          cursor: 14,
          records: [],
          hasMore: false,
          projections: { asOfSeq: 14, values: {} },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'session.subscribed'))
      // Real DSH order: the advisory projection for cursor 15 arrives first,
      // immediately followed by the durable row that actually owns sequence 15.
      socket.message({
        type: 'item',
        streamId: openStreamId('session/control'),
        value: {
          type: 'projection',
          sessionId: 's1',
          key: 'next-turn',
          value: [{ turn: 1, seq: 15 }],
          seq: 15,
        },
      })
      socket.message({
        type: 'item',
        streamId: openStreamId('session/follow'),
        value: {
          type: 'event',
          event: {
            type: 'assistant/message',
            sessionId: 's1',
            seq: 15,
            time: 1_786_406_400_004,
            data: {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'The final answer.' }],
                source: { kind: 'model', provider: 'fixture', model: 'fixture' },
                id: '11111111-1111-4111-8111-111111111111',
              },
              usage: { inputTokens: 4, outputTokens: 4 },
            },
          },
        },
      })
      await waitForEvent(() => received.some((event) => event.type === 'message.completed'))
      expect(received.find((event) => event.type === 'session.projection')).toMatchObject({
        type: 'session.projection',
        sessionId: 's1',
        key: 'next-turn',
        sequence: 15,
      })
      expect(received.find((event) => event.type === 'message.completed')).toMatchObject({
        sessionId: 's1',
        messageId: '11111111-1111-4111-8111-111111111111',
        markdown: 'The final answer.',
        sequence: 15,
      })
      // The shared sequence must never surface as a durable unknown row: the
      // Webview cursor would then consume the slot and drop the completion.
      expect(received.some((event) => event.type === 'unknown')).toBe(false)
    } finally {
      unsubscribe()
      await backend.close()
    }
  })

  it('keeps a pending approval answerable across a session follow re-subscription', async () => {
    FakeWebSocket.instances.length = 0
    const adapter = new Alpha1VersionAdapter({
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

describe('alpha settled interaction reporting', () => {
  it('reports a locally answered question as resolved for the replayed surfaces', async () => {
    const harness = await alphaBackend()
    try {
      harness.socket.message({
        type: 'item',
        streamId: harness.eventsStreamId,
        value: {
          type: 'waterfall',
          event: 'user-questions/request',
          eventId: 'evt-q1',
          agentId: 's1',
          request: {
            questions: [
              {
                id: 'purpose',
                question: 'What is this for?',
                options: [{ label: 'Docs' }, { label: 'Code' }],
              },
            ],
          },
        },
      })
      await waitForEvent(() => harness.received.some((event) => event.type === 'question.requested'))
      await expect(
        harness.backend.interactions.respondToQuestion('purpose', ['Docs']),
      ).resolves.toBeUndefined()
      // The Gateway drops the answering client's delivery before it settles the
      // Remote Event, so this client never receives the `cancel` frame the alpha
      // seam turns into a resolution. Without a local echo the Host replay cache
      // keeps re-posting the request to every new Webview, which then renders a
      // prompt that can no longer be answered (STALE_INTERACTION), and the task
      // center keeps a needs-input row that only ever fails.
      expect(harness.received.filter((event) => event.type === 'question.resolved')).toEqual([
        { type: 'question.resolved', sessionId: 's1', questionRpcId: 'evt-q1', outcome: 'answered' },
      ])
    } finally {
      await harness.close()
    }
  })

  it('reports a locally cancelled question as resolved for the replayed surfaces', async () => {
    const harness = await alphaBackend()
    try {
      harness.socket.message({
        type: 'item',
        streamId: harness.eventsStreamId,
        value: {
          type: 'waterfall',
          event: 'user-questions/request',
          eventId: 'evt-q2',
          agentId: 's1',
          request: { questions: [{ id: 'purpose', question: 'What is this for?' }] },
        },
      })
      await waitForEvent(() => harness.received.some((event) => event.type === 'question.requested'))
      await expect(harness.backend.interactions.cancelQuestion('purpose')).resolves.toBeUndefined()
      expect(harness.received.filter((event) => event.type === 'question.resolved')).toEqual([
        { type: 'question.resolved', sessionId: 's1', questionRpcId: 'evt-q2', outcome: 'cancelled' },
      ])
    } finally {
      await harness.close()
    }
  })

  it('reports a locally answered approval as resolved for the replayed surfaces', async () => {
    const harness = await alphaBackend()
    try {
      harness.socket.message({
        type: 'item',
        streamId: harness.eventsStreamId,
        value: {
          type: 'waterfall',
          event: 'approval/request',
          eventId: 'evt-a1',
          agentId: 's1',
          request: { toolName: 'shell', reason: 'needs approval' },
        },
      })
      await waitForEvent(() => harness.received.some((event) => event.type === 'permission.requested'))
      await expect(
        harness.backend.interactions.respondToPermission('evt-a1', 'allowed-once'),
      ).resolves.toBeUndefined()
      expect(harness.received.filter((event) => event.type === 'permission.resolved')).toEqual([
        { type: 'permission.resolved', sessionId: 's1', requestId: 'evt-a1', outcome: 'allowed-once' },
      ])
    } finally {
      await harness.close()
    }
  })
})

interface AlphaBackendHarness {
  readonly backend: Awaited<ReturnType<Alpha1VersionAdapter['createBackend']>>
  readonly socket: FakeWebSocket
  readonly received: BackendEvent[]
  readonly eventsStreamId: number
  readonly close: () => Promise<void>
}

/** Connect one alpha backend whose `$events` waterfall stream is ready to use. */
async function alphaBackend(): Promise<AlphaBackendHarness> {
  FakeWebSocket.instances.length = 0
  const adapter = new Alpha1VersionAdapter({
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
  const socket = await waitForSocket()
  socket.open()
  await waitForSent(socket, 3)
  let eventsStreamId: number | undefined
  for (const sent of socket.sent) {
    const frame = JSON.parse(sent) as { type?: string; endpoint?: string; streamId?: number }
    if (frame.type === 'open' && frame.endpoint === '$events') eventsStreamId = frame.streamId
  }
  if (eventsStreamId === undefined) throw new Error('the alpha mux never opened $events')
  socket.message({
    type: 'item',
    streamId: eventsStreamId,
    value: { type: 'ready', clientId: 'client-1', host: { home: '/home/tester' } },
  })
  return {
    backend,
    socket,
    received,
    eventsStreamId,
    close: async () => {
      unsubscribe()
      await backend.close()
    },
  }
}
