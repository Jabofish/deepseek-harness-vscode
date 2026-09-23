import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { Alpha171JobRepository } from '../src/versions/alpha171/job-repository.js'
import { Alpha171PluginRepository } from '../src/versions/alpha171/plugin-repository.js'
import { Alpha171PresetRepository } from '../src/versions/alpha171/preset-repository.js'
import { Alpha171VersionAdapter } from '../src/versions/alpha171/adapter.js'
import type { AlphaLoopbackApiClient, AlphaWebSocket } from '../src/versions/alpha/transport.js'
import { callRpc, unwrapRpcResultValue } from '../src/versions/rc6/rpc.js'

/**
 * Fixture authority: DSH tag `dsh-v0.1.7-alpha.1`, commit
 * `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`.
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

function adapter(): Alpha171VersionAdapter {
  return new Alpha171VersionAdapter(adapterOptions)
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

function candidate(runtimeVersion: string): BackendCandidate {
  return {
    endpoint,
    source: 'configured',
    runtimeVersion,
    confidence: 1,
  }
}

function alphaResponse(rpcId: string, value: unknown): Response {
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: true, value },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function alphaFailureResponse(rpcId: string, code: string, details: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code, message: 'fixture failure', details } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
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
    throw new Error('fixture request body has an invalid RPC envelope')
  }
  return { rpcId: record.rpcId, method: record.method }
}

function jsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fixture frame is not an object')
  }
  return parsed as Record<string, unknown>
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function sessionToolResultEvent(): Record<string, unknown> {
  return {
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
        content: [{ type: 'text', text: 'finished' }],
        isError: false,
      },
    },
  }
}

describe('DSH 0.1.7-alpha.1 contract', () => {
  it('uses the exact identity and probes the V4 session plus pinned workspace shape', async () => {
    expect(adapter()).toMatchObject({
      id: 'dsh-0.1.7-alpha.1',
      supportedVersion: '0.1.7-alpha.1',
      protocolVersion: 'alpha171',
      compatibilityPriority: 210,
      fallback: false,
    })
    expect(await adapter().probeCompatibility()).toBeUndefined()

    FakeWebSocket.instances.length = 0
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      if (body.method === 'session/list')
        return Promise.resolve(
          alphaResponse(body.rpcId, { items: [{ sessionId: 's-1', agentAvailable: true }] }),
        )
      throw new Error(`unexpected probe request ${body.method}`)
    })
    const exact = new Alpha171VersionAdapter({ ...adapterOptions, fetch })
    const probing = exact.probe(candidate('0.1.7-alpha.1'))
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] },
      }),
    )

    await expect(probing).resolves.toMatchObject({
      protocolVersion: 'alpha171',
      dshVersion: '0.1.7-alpha.1',
      sessionRestore: true,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts projection-only Session Control and rejects the removed jobs baseline', async () => {
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
          projections: {
            's-1': { asOfSeq: 12, values: { title: 'Pinned' } },
          },
        },
      }),
    )
    await expect(first).resolves.toMatchObject({
      value: {
        type: 'session/projection-baseline',
        projections: { 's-1': { asOfSequence: 12, values: { title: 'Pinned' } } },
      },
    })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const malformedTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformed = malformedTransport.openHostStream(new AbortController().signal)[Symbol.asyncIterator]()
    const malformedFirst = malformed.next()
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    malformedSocket.message(
      streamItem(malformedSocket, {
        type: 'baseline',
        value: { jobs: {}, projections: {} },
      }),
    )
    await expect(malformedFirst).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it('preserves each complete projection baseline, including empty blocks, through readControl', async () => {
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
          projections: {
            's-1': { asOfSeq: 12, values: { title: 'Pinned', plan: { active: true } } },
            's-2': { asOfSeq: 7, values: {} },
          },
        },
      }),
    )

    await expect(first).resolves.toEqual({
      done: false,
      value: {
        type: 'session/projection-baseline',
        projections: {
          's-1': { asOfSequence: 12, values: { title: 'Pinned', plan: { active: true } } },
          's-2': { asOfSequence: 7, values: {} },
        },
      },
    })

    const increment = iterator.next()
    socket.message(
      streamItem(socket, {
        type: 'projection',
        sessionId: 's-1',
        key: 'title',
        value: 'Renamed',
        seq: 13,
      }),
    )
    await expect(increment).resolves.toEqual({
      done: false,
      value: { type: 'session/projection', sessionId: 's-1', key: 'title', value: 'Renamed', seq: 13 },
    })

    const emptyBaseline = iterator.next()
    socket.message(streamItem(socket, { type: 'baseline', value: { projections: {} } }))
    await expect(emptyBaseline).resolves.toEqual({
      done: false,
      value: { type: 'session/projection-baseline', projections: {} },
    })
    await transport.close()
  })

  it('rejects additive fields on the projection baseline', async () => {
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
        value: { projections: {} },
        future: true,
      }),
    )
    await expect(first).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('requires pinned sessions in workspace baselines and exposes the pinned delta', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const workspace = callRpc(transport, 'workspace.list', {})
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(
      streamItem(socket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [], pinnedSessionIds: ['s-1'] },
      }),
    )
    await expect(workspace).resolves.toMatchObject({ pinnedSessionIds: ['s-1'] })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const malformedTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformed = callRpc(malformedTransport, 'workspace.list', {})
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    malformedSocket.message(
      streamItem(malformedSocket, {
        type: 'baseline',
        value: { items: [], archivedSessionIds: [] },
      }),
    )
    await expect(malformed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it('projects the V4 tool-role message only after validating its call identity', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const iterator = transport.openSessionStream('s-1', new AbortController().signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    socket.message(streamItem(socket, { type: 'event', event: sessionToolResultEvent() }))
    await expect(first).resolves.toMatchObject({
      value: {
        type: 'session/event',
        event: {
          type: 'tool/result',
          data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1' }] } },
        },
      },
    })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const malformedTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformedStream = malformedTransport.openSessionStream('s-1', new AbortController().signal)
    const malformedIterator = malformedStream[Symbol.asyncIterator]()
    const malformedFirst = malformedIterator.next()
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    const malformedEvent = sessionToolResultEvent()
    ;((malformedEvent.data as Record<string, unknown>).message as Record<string, unknown>).content = [
      { type: 'tool-result', toolCallId: 'call-1' },
    ]
    malformedSocket.message(streamItem(malformedSocket, { type: 'event', event: malformedEvent }))
    await expect(malformedFirst).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await malformedTransport.close()
  })

  it('reads the standalone whole-set job list stream', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const repository = new Alpha171JobRepository(transport)
    const jobs = repository.list('s-1')
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)
    expect(JSON.parse(socket.sent[0] ?? '{}')).toMatchObject({
      type: 'open',
      endpoint: 'job/list',
      payload: { args: { request: { sessionId: 's-1' } } },
    })
    socket.message(
      streamItem(socket, {
        type: 'rows',
        jobs: [
          {
            id: 'bash-1',
            kind: 'bash',
            label: 'pnpm test',
            status: 'running',
            startedAt: 10,
            output: { total: 24, earliest: 0 },
          },
        ],
      }),
    )
    await expect(jobs).resolves.toEqual([
      {
        id: 'bash-1',
        kind: 'bash',
        label: 'pnpm test',
        status: 'running',
        startedAt: 10,
        output: { total: 24, earliest: 0 },
      },
    ])
    await transport.close()
    expect(socket.closeCalls).toBeGreaterThan(0)
  })

  it('reports cancellation and malformed rows distinctly', async () => {
    FakeWebSocket.instances.length = 0
    const transport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const malformed = new Alpha171JobRepository(transport).list('s-1')
    const malformedSocket = await waitForSocket()
    malformedSocket.open()
    await waitForSent(malformedSocket, 1)
    malformedSocket.message(streamItem(malformedSocket, { type: 'rows', jobs: [{ id: 'missing-output' }] }))
    await expect(malformed).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()

    FakeWebSocket.instances.length = 0
    const cancelledTransport = adapter().createTransport(endpoint) as AlphaLoopbackApiClient
    const cancellation = new AbortController()
    const pending = new Alpha171JobRepository(cancelledTransport).list('s-1', cancellation.signal)
    const cancelledSocket = await waitForSocket()
    cancelledSocket.open()
    await waitForSent(cancelledSocket, 1)
    cancellation.abort('test cancellation')
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(cancelledSocket.sent.map(jsonRecord)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'cancel' })]),
    )
    await cancelledTransport.close()
  })

  it('times out a connected Job Controller stream that never sends its baseline', async () => {
    FakeWebSocket.instances.length = 0
    const transport = new Alpha171VersionAdapter({
      ...adapterOptions,
      requestTimeoutMs: 100,
    }).createTransport(endpoint) as AlphaLoopbackApiClient
    const pending = new Alpha171JobRepository(transport).list('s-1')
    const socket = await waitForSocket()
    socket.open()
    await waitForSent(socket, 1)

    await expect(pending).rejects.toMatchObject({
      code: 'BACKEND_UNREACHABLE',
      context: { method: 'job/list', timedOut: true },
    })
    expect(socket.sent.map(jsonRecord)).toContainEqual(expect.objectContaining({ type: 'cancel' }))
    await transport.close()
  })

  it('maps alpha171 registry-only preset and plugin inventory contracts', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      if (body.method === 'pluginInventory/list')
        return Promise.resolve(
          alphaResponse(body.rpcId, {
            managementAvailable: true,
            entries: [
              {
                entryId: 'entry-1',
                moduleName: '@deepseek-ai/dsh-agent',
                meta: { title: 'Agent' },
                enabled: true,
                fiberPhase: 'active',
              },
            ],
            agentPresets: [
              {
                id: 'standard',
                name: 'Standard',
                isDefault: true,
                rows: [
                  {
                    entryId: 'row-1',
                    moduleName: '@deepseek-ai/dsh-agent',
                    enabled: true,
                    fiberPhase: null,
                  },
                ],
              },
            ],
          }),
        )
      if (body.method === 'agentPresets/list')
        return Promise.resolve(
          alphaResponse(body.rpcId, {
            presets: [{ id: 'standard', name: 'Standard', isDefault: true }],
            modeSelectionEnabled: false,
          }),
        )
      throw new Error(`unexpected alpha171 inventory request ${body.method}`)
    })
    const transport = new Alpha171VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)
    const plugins = await new Alpha171PluginRepository(transport).inventory()
    const presets = await new Alpha171PresetRepository(transport).list()

    expect(plugins).toEqual({
      entries: [
        {
          entryId: 'entry-1',
          moduleName: '@deepseek-ai/dsh-agent',
          meta: { title: 'Agent' },
          enabled: true,
          fiberPhase: 'active',
        },
      ],
      managementAvailable: true,
      agentPresets: [
        {
          id: 'standard',
          trust: 'system',
          name: 'Standard',
          isDefault: true,
          rows: [
            {
              entryId: 'row-1',
              moduleName: '@deepseek-ai/dsh-agent',
              enabled: true,
              fiberPhase: null,
            },
          ],
        },
      ],
    })
    expect(presets).toEqual({
      presets: [{ id: 'standard', trust: 'system', name: 'Standard', isDefault: true }],
      authorable: false,
      compositionReadable: false,
      defaultSettingPath: 'agent-preset-registry.selectedDefault',
      modeSelectionEnabled: false,
    })
    expect((new Alpha171PresetRepository(transport) as { readonly read?: unknown }).read).toBeUndefined()
    expect(fetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      'http://127.0.0.1:4567/api/pluginInventory/list',
      'http://127.0.0.1:4567/api/agentPresets/list',
    ])
    expect(fetch.mock.calls.map(([, init]) => requestBody(init).method)).not.toContain(
      'settings/canOpenAgentPresetDirectory',
    )
    await transport.close()
  })

  it('rejects the removed alpha171 legacy preset roster shape', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      return Promise.resolve(alphaResponse(body.rpcId, { presets: [], authorable: false }))
    })
    const transport = new Alpha171VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)
    await expect(new Alpha171PresetRepository(transport).list()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await transport.close()
  })

  it('maps alpha171 business errors without treating them as wire drift', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = requestBody(init)
      return Promise.resolve(
        alphaFailureResponse(
          body.rpcId,
          body.method === 'workspace/archiveSession' ? 'workspace/session-active' : 'job/not-found',
          { sessionId: 's-1', jobId: 'job-1' },
        ),
      )
    })
    const transport = new Alpha171VersionAdapter({ ...adapterOptions, fetch }).createTransport(endpoint)

    await expect(callRpc(transport, 'workspace.archiveSession', { sessionId: 's-1' })).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      context: { rpcCode: 'workspace-session-active' },
    })
    await expect(
      transport
        .remoteRequest<unknown>('job/kill', { request: { sessionId: 's-1', jobId: 'job-1' } })
        .then((result) => unwrapRpcResultValue(result, 'job/kill')),
    ).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
      context: { rpcCode: 'job-not-found' },
    })
    await transport.close()
  })
})
