import { describe, expect, it, vi } from 'vitest'

import { Alpha2VersionAdapter } from '../src/versions/alpha2/adapter.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { callRpc, unwrapRpcResultValue } from '../src/versions/rc6/rpc.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'
import {
  bodyText,
  endpoint,
  failureResponse,
  wrappedResponse as successResponse,
} from './support/contract-harness.js'
import { FakeWebSocket } from './support/fake-web-socket.js'

function client(fetch: typeof globalThis.fetch, timeout = 1_000): AlphaLoopbackApiClient {
  const adapter = new Alpha2VersionAdapter({
    requestTimeoutMs: timeout,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
    authCookie: () => 'dsh_session=test-cookie',
    webSocket: FakeWebSocket,
  })
  return adapter.createTransport(endpoint) as AlphaLoopbackApiClient
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
  throw new Error('the alpha.2 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`the alpha.2 mux socket sent ${socket.sent.length} frames; expected ${count}`)
}

describe('DSH 0.1.2-alpha.2 Connection/Gateway contract', () => {
  it('normalizes declared namespaced Remote failures without changing the wire envelope', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        failureResponse(init, 'session/agent-busy', 'agent is busy', { reason: 'active turn' }),
      ),
    )
    const transport = client(fetch)

    await expect(callRpc(transport, 'session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      context: { rpcCode: 'agent-busy' },
    })
    const request = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly type: string
      readonly method: string
      readonly payload: unknown
    }
    expect(request).toMatchObject({ type: 'client-request', method: 'session/list' })
    expect(request.payload).toEqual({ args: { _request: {} } })
    await transport.close()
  })

  it('maps Gateway route lookup failures to the existing optional-capability path', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        failureResponse(init, 'gateway/lookup-not-found', 'route missing', { endpoint: 'future/list' }),
      ),
    )
    const transport = client(fetch)

    await expect(
      transport
        .remoteRequest('future/list', {})
        .then((result) => unwrapRpcResultValue(result, 'future/list')),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { rpcCode: 'unknown-command' },
    })
    await transport.close()
  })

  it('fails closed for an undeclared alpha.2 error code', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(failureResponse(init, 'session/future-failure')),
    )
    const transport = client(fetch)

    await expect(callRpc(transport, 'session.list', {})).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      context: { rpcCode: 'session/future-failure' },
    })
    await transport.close()
  })

  it('preserves an unknown ignorable session event through the alpha.2 follow stream', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(successResponse(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'event',
        event: {
          type: 'future/telemetry',
          seq: 0,
          time: 1,
          data: { value: 'safe-to-skip' },
          ignorable: true,
        },
      }),
    )

    await expect(next).resolves.toMatchObject({
      value: {
        type: 'session/event',
        sessionId: 's1',
        event: { type: 'future/telemetry', ignorable: true },
      },
    })
    await iterator.return?.()
    await transport.close()
  })

  it('rejects a malformed non-boolean ignorable marker instead of accepting it as forward-compatible', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(successResponse(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'event',
        event: { type: 'future/telemetry', seq: 0, time: 1, data: {}, ignorable: false },
      }),
    )

    await expect(next).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('normalizes namespaced errors reported by a remote.mux stream', async () => {
    FakeWebSocket.instances.length = 0
    const transport = client(
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(successResponse(init, {}))),
    )
    const iterator = transport.openSessionStream('s1', new AbortController().signal)[Symbol.asyncIterator]()
    const next = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    const opening = JSON.parse(socket.sent[0] ?? '{}') as { readonly streamId?: string }
    socket.message({
      type: 'error',
      streamId: opening.streamId,
      error: { code: 'session/agent-busy', message: 'busy', details: { reason: 'turn' } },
    })

    await expect(next).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      context: { rpcCode: 'agent-busy' },
    })
    await transport.close()
  })

  it('unwraps the shared question response before resolving the alpha.2 waterfall', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(successResponse(init, undefined)),
    )
    const transport = client(fetch)
    const repository = new Rc6InteractionRepository(transport, { resetPendingOnSubscribe: false })
    const iterator = transport.openEventStream(new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }))
    socket.message(
      streamItem(socket, {
        type: 'waterfall',
        event: 'user-questions/request',
        eventId: 'event-question',
        agentId: 's1',
        request: {
          questions: [
            {
              id: 'purpose',
              question: '主要用途?',
              options: [{ label: 'Agent/工具调用' }],
            },
            {
              id: 'quality',
              question: '质量偏好?',
              options: [{ label: '均衡 (推荐)' }],
            },
          ],
        },
      }),
    )
    await expect(first).resolves.toMatchObject({
      value: { type: 'question/requested', rpcId: 'event-question', sessionId: 's1' },
      done: false,
    })

    repository.remember({
      type: 'question.requested',
      question: {
        id: 'purpose',
        rpcId: 'event-question',
        sessionId: 's1',
        prompt: '主要用途?',
        choices: [{ id: 'Agent/工具调用', label: 'Agent/工具调用' }],
        allowFreeText: false,
        items: [
          {
            id: 'purpose',
            prompt: '主要用途?',
            choices: [{ id: 'Agent/工具调用', label: 'Agent/工具调用' }],
            allowFreeText: false,
          },
          {
            id: 'quality',
            prompt: '质量偏好?',
            choices: [{ id: '均衡 (推荐)', label: '均衡 (推荐)' }],
            allowFreeText: false,
          },
        ],
      },
    })
    await repository.respondToQuestion('purpose', [
      { id: 'purpose', response: 'Agent/工具调用' },
      { id: 'quality', response: '均衡 (推荐)' },
    ])

    const request = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly payload: { readonly args: { readonly outcome: unknown } }
    }
    expect(request.payload.args.outcome).toEqual({
      kind: 'result',
      value: {
        answers: [
          { id: 'purpose', selected: ['Agent/工具调用'] },
          { id: 'quality', selected: ['均衡 (推荐)'] },
        ],
      },
    })
    await iterator.return?.()
    await transport.close()
  })
})
