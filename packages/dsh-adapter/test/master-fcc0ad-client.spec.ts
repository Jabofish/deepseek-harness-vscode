import { afterEach, describe, expect, it, vi } from 'vitest'
import { MasterFcc0adClient } from '../src/versions/master-fcc0ad/client.js'
import { MASTER_FCC0AD_COMMIT } from '../src/versions/master-fcc0ad/identity.js'
import {
  bodyText,
  endpoint,
  failureResponse,
  transportOptions,
  wrappedResponse,
} from './support/contract-harness.js'
import { FakeWebSocket } from './support/fake-web-socket.js'
import {
  masterMcpProbe,
  masterMcpServers,
  masterTeam,
  masterWebProviders,
} from './fixtures/master-fcc0ad-contract.js'

type Request = { method: string; payload: { args: Record<string, unknown> } }
const continuation = { sessionId: 'root', requestId: 'continue-request', observedEnding: 4 }
function projection(values: Readonly<Record<string, unknown>>): {
  readonly kind: 'sequenced'
  readonly asOfSeq: number
  readonly values: Readonly<Record<string, unknown>>
} {
  return { kind: 'sequenced', asOfSeq: 5, values }
}

function client(fetch: typeof globalThis.fetch): MasterFcc0adClient {
  const options = transportOptions(fetch)
  return new MasterFcc0adClient(
    { ...options, retryPolicy: { ...options.retryPolicy, maximumAttempts: 3 }, endpoint },
    MASTER_FCC0AD_COMMIT,
  )
}

describe('master fcc0ad Host-only Remote preparation', () => {
  afterEach(() => vi.useRealTimers())

  it('checks the observed failure before requesting native continuation with a caller-owned identity', async () => {
    const requests: Request[] = []
    const remote = client((_url, init) => {
      const request = JSON.parse(bodyText(init)) as Request
      requests.push(request)
      return Promise.resolve(
        wrappedResponse(
          init,
          request.method === 'session/projections'
            ? projection({ conversationContinuation: 4 })
            : { accepted: true },
        ),
      )
    })
    try {
      await remote.continueFailedTurn(continuation)
      expect(requests).toMatchObject([
        { method: 'session/projections', payload: { args: { request: { sessionId: 'root' } } } },
        {
          method: 'session/prompt',
          payload: {
            args: {
              request: {
                sessionId: 'root',
                requestId: 'continue-request',
                mode: 'queue',
                content: [],
              },
            },
          },
        },
      ])
    } finally {
      await remote.close()
    }
  })

  it('leaves the current eligible turn to native admission when another client changes it after preflight', async () => {
    let currentEnding = 4
    let admittedEnding: number | undefined
    const remote = client((_url, init) => {
      const request = JSON.parse(bodyText(init)) as Request
      if (request.method === 'session/projections')
        return Promise.resolve(
          wrappedResponse(init, {
            kind: 'sequenced',
            asOfSeq: currentEnding,
            values: { conversationContinuation: currentEnding },
          }),
        )
      currentEnding = 8
      admittedEnding = currentEnding
      const prompt = request.payload.args.request as Record<string, unknown>
      expect(prompt).not.toHaveProperty('observedEnding')
      expect(prompt).not.toHaveProperty('expectedEnding')
      return Promise.resolve(wrappedResponse(init, { accepted: true }))
    })
    try {
      await remote.continueFailedTurn(continuation)
      expect(admittedEnding).toBe(8)
    } finally {
      await remote.close()
    }
  })

  it.each([null, 3])('refuses a stale continuation when the authoritative ending is %s', async (ending) => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
      Promise.resolve(wrappedResponse(init, projection({ conversationContinuation: ending }))),
    )
    const remote = client(fetch)
    try {
      await expect(remote.continueFailedTurn(continuation)).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await remote.close()
    }
  })

  it.each([
    { value: projection({}), code: 'CAPABILITY_UNAVAILABLE' },
    { value: projection({ conversationContinuation: 6 }), code: 'PROTOCOL_ERROR' },
    { value: projection({ conversationContinuation: -1 }), code: 'PROTOCOL_ERROR' },
    { value: null, code: 'CAPABILITY_UNAVAILABLE' },
    { value: { kind: 'migration-required', values: {} }, code: 'INVALID_CONFIGURATION' },
    { value: { kind: 'migration-required', values: [], extra: true }, code: 'PROTOCOL_ERROR' },
  ])(
    'preserves projection absence, corruption and migration distinctions ($code)',
    async ({ value, code }) => {
      const remote = client((_url, init) => Promise.resolve(wrappedResponse(init, value)))
      try {
        await expect(remote.readContinuation('root')).rejects.toMatchObject({ code })
      } finally {
        await remote.close()
      }
    },
  )

  it('rejects overlapping continuations for the same session and releases the local admission after failure', async () => {
    let rejectPending!: (error: Error) => void
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectPending = reject
    })
    let calls = 0
    const remote = client((_url, init) => {
      calls++
      return calls === 1
        ? pending
        : Promise.resolve(wrappedResponse(init, projection({ conversationContinuation: null })))
    })
    try {
      const first = remote.continueFailedTurn(continuation)
      await expect(
        remote.continueFailedTurn({ ...continuation, requestId: 'second-request' }),
      ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
      // The deferred projection fails before mutation. Its local gate must release.
      rejectPending(new TypeError('Fixture disconnect'))
      await expect(first).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
      await expect(remote.continueFailedTurn(continuation)).rejects.toMatchObject({
        code: 'INVALID_CONFIGURATION',
      })
      expect(calls).toBe(2)
    } finally {
      await remote.close()
    }
  })

  it('retains complete Host-only Team reads and sends the generated Agent lookup argument on selection', async () => {
    const requests: Request[] = []
    const remote = client((_url, init) => {
      const request = JSON.parse(bodyText(init)) as Request
      requests.push(request)
      return Promise.resolve(
        wrappedResponse(
          init,
          request.method === 'session/projections' ? projection({ agentTeam: masterTeam }) : undefined,
        ),
      )
    })
    try {
      expect(await remote.readTeam('root')).toEqual(masterTeam)
      await remote.setTeamEnabled('root', false)
      expect(requests.at(-1)).toMatchObject({
        method: 'agentTeams/setEnabled',
        payload: { args: { agentId: 'root', enabled: false } },
      })
    } finally {
      await remote.close()
    }
  })

  it('discovers provider catalogues and preserves MCP cleanup separately from probe success', async () => {
    const requests: Request[] = []
    const remote = client((_url, init) => {
      const request = JSON.parse(bodyText(init)) as Request
      requests.push(request)
      const value =
        request.method === 'web/listProviders'
          ? masterWebProviders
          : request.method === 'mcpManager/probe'
            ? masterMcpProbe
            : undefined
      return Promise.resolve(wrappedResponse(init, value))
    })
    try {
      expect(await remote.listWebProviders()).toEqual(masterWebProviders)
      expect(await remote.probeMcp('fixture-server')).toEqual(masterMcpProbe)
      await remote.restartMcp('fixture-server')
      expect(requests.map((request) => request.method)).toEqual([
        'web/listProviders',
        'mcpManager/probe',
        'mcpManager/restart',
      ])
      expect(requests[1]?.payload.args).toEqual({ name: 'fixture-server' })
    } finally {
      await remote.close()
    }
  })

  it('accepts both declared LocalizedText forms and rejects a missing English fallback', async () => {
    let description: unknown = 'Literal provider description'
    const remote = client((_url, init) =>
      Promise.resolve(
        wrappedResponse(init, {
          search: [{ id: 'provider', description }],
          fetch: [],
        }),
      ),
    )
    try {
      expect((await remote.listWebProviders()).search[0]?.description).toBe(description)
      description = { zh: '缺少英文回退' }
      await expect(remote.listWebProviders()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await remote.close()
    }
  })

  it.each(['continuation', 'team', 'probe', 'restart'] as const)(
    'sends %s only once after an uncertain outcome',
    async (operation) => {
      let writes = 0
      const remote = client((_url, init) => {
        const request = JSON.parse(bodyText(init)) as Request
        if (request.method === 'session/projections')
          return Promise.resolve(wrappedResponse(init, projection({ conversationContinuation: 4 })))
        writes++
        return Promise.reject(new TypeError('Fixture receipt lost after dispatch'))
      })
      try {
        const result =
          operation === 'continuation'
            ? remote.continueFailedTurn(continuation)
            : operation === 'team'
              ? remote.setTeamEnabled('root', true)
              : operation === 'probe'
                ? remote.probeMcp('fixture-server')
                : remote.restartMcp('fixture-server')
        await expect(result).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
        expect(writes).toBe(1)
      } finally {
        await remote.close()
      }
    },
  )

  it('propagates a business refusal and timeout without a write retry', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) =>
      Promise.resolve(failureResponse(init, 'session/agent-busy', 'Fixture refusal')),
    )
    const remote = client(fetch)
    try {
      await expect(remote.setTeamEnabled('root', true)).rejects.toMatchObject({
        context: { rpcMethod: 'agentTeams/setEnabled' },
      })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      await remote.close()
    }
    const timeout = client(() => Promise.reject(new DOMException('Fixture timeout', 'TimeoutError')))
    try {
      await expect(timeout.restartMcp('fixture-server')).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
      })
    } finally {
      await timeout.close()
    }
  })

  it('rejects invalid input and cancellation before dispatch, and closes idempotently', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const remote = client(fetch)
    const abort = new AbortController()
    abort.abort()
    await expect(remote.listWebProviders(abort.signal)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await expect(remote.continueFailedTurn({ ...continuation, requestId: '' })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    await expect(remote.probeMcp('')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(fetch).not.toHaveBeenCalled()
    const closing = remote.close()
    expect(remote.close()).toBe(closing)
    await closing
    await expect(remote.listWebProviders()).rejects.toMatchObject({ code: 'BACKEND_UNREACHABLE' })
  })

  it('cancels an in-flight unary read when its preparation client closes', async () => {
    let requestSignal: AbortSignal | null | undefined
    const remote = client((_url, init) => {
      requestSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('Fixture request cancelled', 'AbortError')),
          { once: true },
        )
      })
    })
    const result = expect(remote.listWebProviders()).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await remote.close()
    await result
    expect(requestSignal?.aborted).toBe(true)
  })

  it('rejects a malformed MCP snapshot and releases that subscription', async () => {
    const sockets: FakeWebSocket[] = []
    class MalformedSocket extends FakeWebSocket {
      public constructor(...args: ConstructorParameters<typeof FakeWebSocket>) {
        super(...args)
        sockets.push(this)
        queueMicrotask(() => this.open())
      }
      public override send(data: string): void {
        super.send(data)
        const frame = JSON.parse(data) as { type: string; streamId: string }
        if (frame.type === 'open')
          queueMicrotask(() =>
            this.message({
              type: 'item',
              streamId: frame.streamId,
              value: [...masterMcpServers, ...masterMcpServers],
            }),
          )
      }
    }
    const remote = new MasterFcc0adClient(
      { ...transportOptions(globalThis.fetch), endpoint, webSocket: MalformedSocket },
      MASTER_FCC0AD_COMMIT,
    )
    const iterator = remote.watchMcp()
    try {
      await expect(iterator.next()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    } finally {
      await iterator.return(undefined)
      await remote.close()
    }
    expect(sockets[0]?.sent.some((value) => (JSON.parse(value) as { type: string }).type === 'cancel')).toBe(
      true,
    )
    expect(sockets[0]?.closeCalls).toBe(1)
  })

  it('validates MCP snapshots and cancels the logical stream before closing its socket', async () => {
    const sockets: FakeWebSocket[] = []
    class Socket extends FakeWebSocket {
      public constructor(...args: ConstructorParameters<typeof FakeWebSocket>) {
        super(...args)
        sockets.push(this)
        queueMicrotask(() => this.open())
      }
      public override send(data: string): void {
        super.send(data)
        const frame = JSON.parse(data) as { type: string; streamId: string; endpoint: string }
        if (frame.type === 'open') {
          expect(frame.endpoint).toBe('mcpManager/watch')
          queueMicrotask(() =>
            this.message({ type: 'item', streamId: frame.streamId, value: masterMcpServers }),
          )
        }
      }
    }
    const remote = new MasterFcc0adClient(
      { ...transportOptions(globalThis.fetch), endpoint, webSocket: Socket },
      MASTER_FCC0AD_COMMIT,
    )
    const iterator = remote.watchMcp()
    try {
      expect(await iterator.next()).toEqual({ done: false, value: masterMcpServers })
      await iterator.return(undefined)
      expect(sockets[0]?.sent.map((value) => (JSON.parse(value) as { type: string }).type)).toEqual([
        'open',
        'cancel',
      ])
    } finally {
      await iterator.return(undefined)
      await remote.close()
    }
    expect(sockets[0]?.closeCalls).toBe(1)
  })

  it('bounds waiting for an MCP baseline and releases a timed-out subscription', async () => {
    vi.useFakeTimers()
    const sockets: FakeWebSocket[] = []
    class SilentSocket extends FakeWebSocket {
      public constructor(...args: ConstructorParameters<typeof FakeWebSocket>) {
        super(...args)
        sockets.push(this)
        queueMicrotask(() => this.open())
      }
    }
    const remote = new MasterFcc0adClient(
      { ...transportOptions(globalThis.fetch), endpoint, webSocket: SilentSocket },
      MASTER_FCC0AD_COMMIT,
    )
    const iterator = remote.watchMcp()
    try {
      const result = expect(iterator.next()).rejects.toMatchObject({
        code: 'BACKEND_UNREACHABLE',
        context: { timedOut: true },
      })
      await vi.advanceTimersByTimeAsync(1_001)
      await result
    } finally {
      await iterator.return(undefined)
      await remote.close()
    }
    expect(sockets[0]?.closeCalls).toBe(1)
  })
})
