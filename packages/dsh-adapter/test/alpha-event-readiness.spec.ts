import { describe, expect, it, vi } from 'vitest'

import type { BackendEndpoint } from '@dsh-vscode/domain'

import { readPermissionCatalog } from '../src/versions/alpha161/permission-catalog.js'
import { AlphaLoopbackApiClient, type AlphaWebSocket } from '../src/versions/alpha/transport.js'

class FakeWebSocket implements AlphaWebSocket {
  public static readonly instances: FakeWebSocket[] = []
  public readyState = 0
  public readonly sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  public constructor(public readonly url: string) {
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
    const listeners = this.listeners.get(type) ?? new Set<(event: unknown) => void>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
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

function rpcResponse(init: RequestInit | undefined, value: unknown): Response {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId: string }
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value },
    }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function eventStreamId(socket: FakeWebSocket): string {
  const opening = socket.sent
    .map((frame) => JSON.parse(frame) as { readonly endpoint?: unknown; readonly streamId?: unknown })
    .find((frame) => frame.endpoint === '$events')
  if (typeof opening?.streamId !== 'string') throw new Error('the alpha mux did not open $events')
  return opening.streamId
}

async function waitForSocket(): Promise<FakeWebSocket> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = FakeWebSocket.instances[0]
    if (socket !== undefined) return socket
    await Promise.resolve()
  }
  throw new Error('the alpha mux socket was not created')
}

async function waitForEventStreamOpen(socket: FakeWebSocket): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = socket.sent.length > 0 ? eventStreamId(socket) : undefined
    if (id !== undefined) return id
    await Promise.resolve()
  }
  throw new Error('the alpha mux did not send the $events opening frame')
}

function readyItem(streamId: string): unknown {
  return {
    type: 'item',
    streamId,
    value: { type: 'ready', clientId: 'client-1', host: { home: '/home/tester' } },
  }
}

describe('alpha event stream readiness barrier', () => {
  it('waits for `$events` ready before making the first permission catalog request', async () => {
    FakeWebSocket.instances.length = 0
    const paths: string[] = []
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      paths.push(new URL(requestUrl).pathname)
      return Promise.resolve(
        rpcResponse(init, {
          options: [
            { value: 'workspace-write', name: 'Workspace Write' },
            { value: 'auto', name: 'Auto' },
          ],
        }),
      )
    })
    const transport = client(fetch)
    const eventStream = transport.openEventStream()[Symbol.asyncIterator]()
    const firstEvent = eventStream.next()
    const catalog = readPermissionCatalog(transport)
    const socket = await waitForSocket()
    socket.open()
    const streamId = await waitForEventStreamOpen(socket)

    expect(paths).toEqual([])
    socket.message(readyItem(streamId))

    await expect(catalog).resolves.toEqual(['workspace-write', 'auto'])
    expect(paths).toEqual(['/api/permissionPresets/catalog'])

    await transport.close()
    await expect(firstEvent).resolves.toMatchObject({ done: true })
  })

  it('keeps caller cancellation local and permits a later catalog read after readiness', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        rpcResponse(init, { options: [{ value: 'workspace-write', name: 'Workspace Write' }] }),
      ),
    )
    const transport = client(fetch)
    const eventStream = transport.openEventStream()[Symbol.asyncIterator]()
    const firstEvent = eventStream.next()
    const cancellation = new AbortController()
    const catalog = readPermissionCatalog(transport, cancellation.signal)
    cancellation.abort()
    await expect(catalog).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(fetch).not.toHaveBeenCalled()

    const socket = await waitForSocket()
    socket.open()
    const streamId = await waitForEventStreamOpen(socket)
    socket.message(readyItem(streamId))

    await expect(readPermissionCatalog(transport)).resolves.toEqual(['workspace-write'])
    expect(fetch).toHaveBeenCalledTimes(1)
    await transport.close()
    await expect(firstEvent).resolves.toMatchObject({ done: true })
  })

  it('rejects the waiting catalog read when the subscription fails before ready', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(rpcResponse(init, { options: [] })),
    )
    const transport = client(fetch)
    const eventStream = transport.openEventStream()[Symbol.asyncIterator]()
    const firstEvent = eventStream.next()
    const catalog = readPermissionCatalog(transport)
    const socket = await waitForSocket()
    socket.open()
    const streamId = await waitForEventStreamOpen(socket)
    socket.message({ type: 'item', streamId, value: { type: 'emit', event: 'too-early', args: [] } })

    await expect(firstEvent).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(catalog).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(fetch).not.toHaveBeenCalled()
    await transport.close()
  })

  it('rejects a pending readiness wait when the transport is disconnected', async () => {
    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(rpcResponse(init, { options: [] })),
    )
    const transport = client(fetch)
    const eventStream = transport.openEventStream()[Symbol.asyncIterator]()
    const firstEvent = eventStream.next()
    const catalog = readPermissionCatalog(transport)

    await transport.close()

    await expect(catalog).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(firstEvent).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
