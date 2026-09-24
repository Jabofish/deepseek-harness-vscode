import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { Alpha171VersionAdapter } from '../src/versions/alpha171/adapter.js'
import { Alpha172VersionAdapter } from '../src/versions/alpha172/adapter.js'
import { Rc171VersionAdapter } from '../src/versions/rc171/adapter.js'
import type { AlphaLoopbackApiClient, AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { normalizeAlpha171Event } from '../src/versions/alpha171/session-wire.js'
import { assertCanonicalSessionEvent, rc6Mapper } from '../src/versions/rc6/mapper.js'

/** Fixture authority: DSH tag `dsh-v0.1.7-alpha.2`, commit `00102833dfaee1da9f48a3a8eae9d34005a75218`. */
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

interface RpcRequestBody {
  readonly rpcId: string
  readonly method: string
}

function candidate(runtimeVersion: string): BackendCandidate {
  return {
    endpoint,
    source: 'configured',
    runtimeVersion,
    confidence: 1,
  }
}

function alphaResponse(rpcId: string, value: unknown): Response {
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(init?: RequestInit): RpcRequestBody {
  if (typeof init?.body !== 'string') throw new Error('fixture request body is not a JSON string')
  const parsed: unknown = JSON.parse(init.body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fixture request body is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.rpcId !== 'string' || typeof record.method !== 'string') {
    throw new Error('fixture request body has an invalid RPC envelope')
  }
  return { rpcId: record.rpcId, method: record.method }
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

async function waitForSent(socket: FakeWebSocket): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length > 0) return
    await Promise.resolve()
  }
  throw new Error('the alpha mux socket did not send its stream request')
}

function resetSockets(): void {
  FakeWebSocket.instances.length = 0
}

async function sessionFollowRequest(
  adapter: Alpha171VersionAdapter | Alpha172VersionAdapter | Rc171VersionAdapter,
): Promise<Record<string, unknown>> {
  resetSockets()
  const transport = adapter.createTransport(endpoint) as AlphaLoopbackApiClient
  const controller = new AbortController()
  const iterator = transport.openSessionStream('s-1', controller.signal)[Symbol.asyncIterator]()
  const first = iterator.next()
  try {
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket)
    const opening = JSON.parse(socket.sent[0] ?? '{}') as {
      readonly endpoint?: unknown
      readonly payload?: { readonly args?: { readonly request?: Record<string, unknown> } }
    }
    if (opening.endpoint !== 'session/follow') throw new Error('unexpected alpha stream endpoint')
    socket.message(
      streamItem(socket, {
        type: 'snapshot',
        header: { version: 4, id: 's-1', createdAt: 1, isSeeded: false, delegationDepth: 0 },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
        assistantStream: { revision: 0 },
      }),
    )
    await expect(first).resolves.toEqual({
      done: false,
      value: { type: 'session/queue', sessionId: 's-1', items: [], asOfSequence: 0 },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'session/subscribed', sessionId: 's-1', lastSeq: 0 },
    })
    return opening.payload?.args?.request ?? {}
  } finally {
    controller.abort()
    await iterator.return?.()
    await transport.close()
  }
}

describe('DSH 0.1.7-alpha.2 contract', () => {
  it('selects a distinct exact identity and probes the retained Session V4 and pinned Workspace contract', async () => {
    expect(new Alpha172VersionAdapter(adapterOptions)).toMatchObject({
      id: 'dsh-0.1.7-alpha.2',
      supportedVersion: '0.1.7-alpha.2',
      protocolVersion: 'alpha172',
      compatibilityPriority: 220,
      fallback: false,
    })
    expect(await new Alpha172VersionAdapter(adapterOptions).probeCompatibility()).toBeUndefined()

    resetSockets()
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      if (body.method !== 'session/list') throw new Error(`unexpected HTTP probe request ${body.method}`)
      return Promise.resolve(
        alphaResponse(body.rpcId, { items: [{ sessionId: 's-1', agentAvailable: true }] }),
      )
    })
    const exact = new Alpha172VersionAdapter({ ...adapterOptions, fetch })
    const probing = exact.probe(candidate('0.1.7-alpha.2'))
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
      }),
    )

    await expect(probing).resolves.toMatchObject({
      protocolVersion: 'alpha172',
      dshVersion: '0.1.7-alpha.2',
      sessionRestore: true,
      jobController: true,
      compatibilityMode: 'exact',
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(socket.closeCalls).toBe(1)
  })

  it('does not open a transport for another exact runtime label', async () => {
    resetSockets()
    const fetch = vi.fn()
    const exact = new Alpha172VersionAdapter({ ...adapterOptions, fetch })

    await expect(exact.probe(candidate('0.1.7-alpha.1'))).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('enables turn-window history only on the alpha.2 profile', async () => {
    const alpha172 = new Alpha172VersionAdapter(adapterOptions).createTransport(endpoint)
    const alpha171 = new Alpha171VersionAdapter(adapterOptions).createTransport(endpoint)

    try {
      expect(alpha172.sessionHistoryTurnWindow).toBe(true)
      expect(alpha171.sessionHistoryTurnWindow).toBe(false)
    } finally {
      await Promise.all([alpha172.close(), alpha171.close()])
    }
  })

  it('applies the exact turn-window to follow snapshots only on alpha.2 and rc.1', async () => {
    await expect(sessionFollowRequest(new Alpha171VersionAdapter(adapterOptions))).resolves.toEqual({
      address: { kind: 'session', sessionId: 's-1' },
      maxMessages: 50,
      assistantStream: true,
    })
    const exactWindow = {
      address: { kind: 'session', sessionId: 's-1' },
      maxMessages: 500,
      turnWindow: { minMessages: 50, minTurns: 2 },
      assistantStream: true,
    }
    await expect(sessionFollowRequest(new Alpha172VersionAdapter(adapterOptions))).resolves.toEqual(
      exactWindow,
    )
    await expect(sessionFollowRequest(new Rc171VersionAdapter(adapterOptions))).resolves.toEqual(exactWindow)
  })

  it('declines malformed Session and Workspace probe values and closes opened transports', async () => {
    resetSockets()
    const malformedSessionFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      return Promise.resolve(alphaResponse(body.rpcId, { items: [{ sessionId: 's-1' }] }))
    })
    await expect(
      new Alpha172VersionAdapter({ ...adapterOptions, fetch: malformedSessionFetch }).probe(
        candidate('0.1.7-alpha.2'),
      ),
    ).resolves.toBeUndefined()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]?.closeCalls).toBe(1)

    resetSockets()
    const validSessionFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      return Promise.resolve(
        alphaResponse(body.rpcId, { items: [{ sessionId: 's-1', agentAvailable: true }] }),
      )
    })
    const probing = new Alpha172VersionAdapter({ ...adapterOptions, fetch: validSessionFetch }).probe(
      candidate('0.1.7-alpha.2'),
    )
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket)
    socket.message(streamItem(socket, { type: 'baseline', value: { items: [], archivedSessionIds: [] } }))

    await expect(probing).resolves.toBeUndefined()
    expect(validSessionFetch).toHaveBeenCalledOnce()
    expect(socket.closeCalls).toBe(1)
  })

  it('propagates caller abort while waiting for the Workspace baseline and disposes the mux', async () => {
    resetSockets()
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      return Promise.resolve(
        alphaResponse(body.rpcId, { items: [{ sessionId: 's-1', agentAvailable: true }] }),
      )
    })
    const controller = new AbortController()
    const reason = new DOMException('probe stopped', 'AbortError')
    const probing = new Alpha172VersionAdapter({ ...adapterOptions, fetch }).probe(
      candidate('0.1.7-alpha.2'),
      controller.signal,
    )
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket)
    controller.abort(reason)

    await expect(probing).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(socket.closeCalls).toBe(1)
  })

  it('preserves projectContent text and image blocks through V4 normalization and result mapping', () => {
    // DSH alpha.2 MCP projectContent() returns core text blocks and admitted
    // images as { type: 'image', attachment: ImageAttachmentRef }.
    const attachment = {
      attachmentId: 'a'.repeat(64),
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
      name: 'result.png',
    }
    const event = {
      type: 'tool/result',
      seq: 7,
      time: 8,
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: 0,
        message: {
          id: 'tool-message-1',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-1' },
          toolCallId: 'call-1',
          content: [
            { type: 'text', text: 'prepared' },
            { type: 'image', attachment },
          ],
          isError: false,
        },
      },
    }

    const normalized = normalizeAlpha171Event(event)
    expect(normalized).toMatchObject({
      type: 'tool/result',
      data: {
        message: {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              content: [
                { type: 'text', text: 'prepared' },
                { type: 'image', attachment },
              ],
              isError: false,
            },
          ],
        },
      },
    })

    assertCanonicalSessionEvent('tool/result', { data: normalized.data })
    const mapped = rc6Mapper.event('tool/result', { sessionId: 's-1', data: normalized.data })
    expect(mapped).toMatchObject({
      type: 'tool.updated',
      sessionId: 's-1',
      tool: {
        id: 'call-1',
        outputSummary: 'prepared',
        images: [attachment],
      },
    })
  })
})
