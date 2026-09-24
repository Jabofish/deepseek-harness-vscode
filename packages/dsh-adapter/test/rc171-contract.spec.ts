import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { Rc171VersionAdapter } from '../src/versions/rc171/adapter.js'
import { Alpha171JobRepository } from '../src/versions/alpha171/job-repository.js'
import type {
  AlphaLoopbackApiClient,
  AlphaLoopbackApiClientOptions,
  AlphaWebSocket,
} from '../src/versions/alpha/transport.js'

/**
 * Fixture authority: DSH tag `dsh-v0.1.7-rc.1`, commit
 * `46a7f68b0922371ce7144b668b90e377d8e799f4`.
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

const adapterOptions = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
  webSocket: FakeWebSocket,
}

function adapter(fetch: typeof globalThis.fetch = globalThis.fetch): Rc171VersionAdapter {
  return new Rc171VersionAdapter({ ...adapterOptions, fetch })
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

interface RpcRequestBody {
  readonly rpcId: string
  readonly method: string
}

function requestBody(init?: RequestInit): RpcRequestBody {
  if (typeof init?.body !== 'string') throw new Error('fixture request body is not a JSON string')
  const parsed: unknown = JSON.parse(init.body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fixture request body is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.rpcId !== 'string' || typeof record.method !== 'string') {
    throw new Error('fixture request envelope is malformed')
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
  throw new Error('the RC1 mux socket was not created')
}

async function waitForSent(socket: FakeWebSocket, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (socket.sent.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`the RC1 mux sent ${socket.sent.length} frames; expected ${count}`)
}

function validSessionListFetch(): typeof globalThis.fetch {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    const body = requestBody(init)
    if (body.method !== 'session/list') throw new Error(`unexpected probe request ${body.method}`)
    return Promise.resolve(alphaResponse(body.rpcId, { items: [{ sessionId: 's-1', agentAvailable: true }] }))
  })
}

class InspectableRc171VersionAdapter extends Rc171VersionAdapter {
  public transportProfile(): {
    readonly sessionWireVersion: AlphaLoopbackApiClientOptions['sessionWireVersion']
    readonly controlWireVersion: AlphaLoopbackApiClientOptions['controlWireVersion']
    readonly workspaceWireVersion: AlphaLoopbackApiClientOptions['workspaceWireVersion']
    readonly presetWireVersion: AlphaLoopbackApiClientOptions['presetWireVersion']
    readonly sessionHistoryTurnWindow: AlphaLoopbackApiClientOptions['sessionHistoryTurnWindow']
  } {
    const options = this.createTransportOptions(endpoint)
    return {
      sessionWireVersion: options.sessionWireVersion,
      controlWireVersion: options.controlWireVersion,
      workspaceWireVersion: options.workspaceWireVersion,
      presetWireVersion: options.presetWireVersion,
      sessionHistoryTurnWindow: options.sessionHistoryTurnWindow,
    }
  }

  public jobRepository(transport: AlphaLoopbackApiClient): unknown {
    return this.createJobRepository(transport)
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
})

describe('DSH 0.1.7-rc.1 exact adapter contract', () => {
  it('probes the pinned Session V4 and Workspace baseline and reports the active Web Job Controller', async () => {
    const fetch = validSessionListFetch()
    const exact = adapter(fetch)

    expect(exact).toMatchObject({
      id: 'dsh-0.1.7-rc.1',
      supportedVersion: '0.1.7-rc.1',
      protocolVersion: 'rc171',
      compatibilityPriority: 230,
      fallback: false,
    })
    expect(await exact.probe(candidate('0.1.7-alpha.1'))).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()

    const probing = exact.probe(candidate('0.1.7-rc.1'))
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
      }),
    )

    const capabilities = await probing
    expect(capabilities).toMatchObject({
      protocolVersion: 'rc171',
      dshVersion: '0.1.7-rc.1',
      sessionRestore: true,
      jobController: true,
      compatibilityMode: 'exact',
    })
    expect(capabilities?.features.has('jobs')).toBe(true)
    expect(capabilities?.featureProfile?.source).toBe('pinned-adapter')
    expect(fetch).toHaveBeenCalledOnce()
    expect(socket.closeCalls).toBe(1)
  })

  it('retains the Session V4 profile and enables RC1 Turn-window shaping', () => {
    expect(new InspectableRc171VersionAdapter(adapterOptions).transportProfile()).toEqual({
      sessionWireVersion: 'v4',
      controlWireVersion: 'projection-v2',
      workspaceWireVersion: 'pinned-v2',
      presetWireVersion: 'registry-v2',
      sessionHistoryTurnWindow: true,
    })
  })

  it('keeps the dedicated Job Controller repository on the RC1 profile', () => {
    const repository = new InspectableRc171VersionAdapter(adapterOptions).jobRepository(
      {} as AlphaLoopbackApiClient,
    )

    if (!(repository instanceof Alpha171JobRepository))
      throw new Error('RC1 Job Controller repository mismatch')
    expect(typeof repository.watchRows).toBe('function')
    expect(typeof repository.follow).toBe('function')
    expect(typeof repository.kill).toBe('function')
  })

  it('does not expose RC1-only fields through a compatibility probe', async () => {
    const fetch = validSessionListFetch()
    const exact = adapter(fetch)

    await expect(exact.probeCompatibility()).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('declines a malformed pinned Workspace baseline and closes the mux', async () => {
    const exact = adapter(validSessionListFetch())
    const probing = exact.probe(candidate('0.1.7-rc.1'))
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [] },
      }),
    )

    await expect(probing).resolves.toBeUndefined()
    expect(socket.closeCalls).toBe(1)
  })

  it('propagates probe cancellation and releases its open mux', async () => {
    const exact = adapter(validSessionListFetch())
    const cancellation = new AbortController()
    const probing = exact.probe(candidate('0.1.7-rc.1'), cancellation.signal)
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    cancellation.abort(new Error('fixture cancelled probe'))

    await expect(probing).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(socket.closeCalls).toBe(1)
  })
})
