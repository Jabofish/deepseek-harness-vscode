import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha5VersionAdapter } from '../src/versions/alpha5/adapter.js'
import { callRpc } from '../src/versions/rc6/rpc.js'

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

function response(init: RequestInit | undefined, result: unknown): Response {
  const request = JSON.parse(bodyText(init)) as { readonly rpcId?: string }
  return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

function bodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
}

function requestBody(init: RequestInit | undefined): {
  readonly type?: string
  readonly method?: string
  readonly payload?: {
    readonly args?: { readonly request?: { readonly content?: unknown } }
  }
} {
  return JSON.parse(bodyText(init)) as {
    readonly type?: string
    readonly method?: string
    readonly payload?: {
      readonly args?: { readonly request?: { readonly content?: unknown } }
    }
  }
}

function adapter(fetch: typeof globalThis.fetch): Alpha5VersionAdapter {
  return new Alpha5VersionAdapter({
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  })
}

describe('DSH 0.1.2-alpha.5 Connection/Gateway contract', () => {
  it('selects only the exact alpha.5 runtime and keeps its independent identity', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const versioned = adapter(fetch)

    await expect(versioned.probe(candidate('0.1.2-alpha.5'))).resolves.toMatchObject({
      protocolVersion: 'alpha5',
      dshVersion: '0.1.2-alpha.5',
      subagentImagePrompts: true,
    })
    await expect(versioned.probe(candidate('0.1.2-alpha.4'))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uses alpha.5 as the newest verified implementation for an unknown future runtime', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const connected = await new VersionedBackendProbe([adapter(fetch)]).probe(candidate('0.1.2-alpha.6'))

    expect(connected).toMatchObject({
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha5',
        dshVersion: '0.1.2-alpha.6',
        adapterId: 'dsh-0.1.2-alpha.5',
        compatibilityMode: 'best-effort',
        subagentImagePrompts: false,
        featureProfile: { source: 'compatibility-fallback' },
      },
    })
    expect(connected?.capabilities.compatibilityWarning).toContain('0.1.2-alpha.6')
  })

  it('retains the alpha Remote error mapper at the alpha.5 version boundary', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          ok: false,
          error: { code: 'session/agent-busy', message: 'agent is busy', details: {} },
        }),
      ),
    )
    const transport = versionedTransport(adapter(fetch))

    await expect(callRpc(transport, 'session.list', {})).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      context: { rpcCode: 'agent-busy' },
    })
    await transport.close()
  })

  it('projects the void agentPresets/copy success using the requested destination id', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: undefined })),
    )
    const transport = versionedTransport(adapter(fetch))

    await expect(
      transport.request('agentPreset.copy', {
        from: 'standard',
        agentPreset: 'my-copy',
        name: 'My copy',
      }),
    ).resolves.toMatchObject({ result: { ok: true, value: { agentPreset: 'my-copy' } } })

    const request = JSON.parse(bodyText(fetch.mock.calls[0]?.[1])) as {
      readonly method?: string
      readonly payload?: { readonly args?: Record<string, unknown> }
    }
    expect(request).toMatchObject({
      method: 'agentPresets/copy',
      payload: { args: { from: 'standard', id: 'my-copy', name: 'My copy' } },
    })
    await transport.close()
  })

  it('joins the alpha preset roster with the independent native-opener capability', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(bodyText(init)) as { readonly method?: string }
      if (request.method === 'agentPresets/list')
        return Promise.resolve(response(init, { ok: true, value: { presets: [], authorable: false } }))
      if (request.method === 'settings/canOpenAgentPresetDirectory')
        return Promise.resolve(response(init, { ok: true, value: true }))
      throw new Error(`unexpected alpha.5 endpoint: ${request.method ?? '<missing>'}`)
    })
    const transport = versionedTransport(adapter(fetch))

    await expect(transport.request('agentPreset.list', {})).resolves.toMatchObject({
      result: { ok: true, value: { presets: [], authorable: false, hasDocument: true } },
    })
    expect(
      fetch.mock.calls.map((call) => (JSON.parse(bodyText(call[1])) as { readonly method?: string }).method),
    ).toEqual(['agentPresets/list', 'settings/canOpenAgentPresetDirectory'])
    await transport.close()
  })

  it('keeps the alpha preset roster usable when the optional native-opener probe fails', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(bodyText(init)) as { readonly method?: string }
      if (request.method === 'agentPresets/list')
        return Promise.resolve(response(init, { ok: true, value: { presets: [], authorable: false } }))
      if (request.method === 'settings/canOpenAgentPresetDirectory')
        return Promise.reject(new Error('settings controller is unavailable'))
      throw new Error(`unexpected alpha.5 endpoint: ${request.method ?? '<missing>'}`)
    })
    const transport = versionedTransport(adapter(fetch))

    await expect(transport.request('agentPreset.list', {})).resolves.toMatchObject({
      result: { ok: true, value: { presets: [], authorable: false, hasDocument: false } },
    })
    await transport.close()
  })

  it('does not coerce a malformed preset hasDocument capability into false', async () => {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(bodyText(init)) as { readonly method?: string }
      if (request.method === 'agentPresets/list')
        return Promise.resolve(
          response(init, { ok: true, value: { presets: [], authorable: false, hasDocument: 'yes' } }),
        )
      if (request.method === 'settings/canOpenAgentPresetDirectory')
        return Promise.resolve(response(init, { ok: true, value: true }))
      throw new Error(`unexpected alpha.5 endpoint: ${request.method ?? '<missing>'}`)
    })
    const transport = versionedTransport(adapter(fetch))

    await expect(transport.request('agentPreset.list', {})).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await transport.close()
  })

  it('forwards the optional goal round cap through both alpha goal mutations', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(bodyText(init)) as { readonly method?: string }
      const value =
        body.method === 'goals/create'
          ? { ref: { id: 'goal-1', revision: 1 } }
          : { ref: { id: 'goal-1', revision: 2 } }
      return Promise.resolve(response(init, { ok: true, value }))
    })
    const transport = versionedTransport(adapter(fetch))

    await transport.request('goal.create', { sessionId: 's1', objective: 'Bounded work', maxGoalRounds: 7 })
    await transport.request('goal.edit', {
      sessionId: 's1',
      ref: { id: 'goal-1', revision: 1 },
      maxGoalRounds: 9,
    })

    const requests = fetch.mock.calls.map(
      (call) => JSON.parse(bodyText(call[1])) as { payload?: { args?: unknown } },
    )
    expect(requests.map((request) => request.payload?.args)).toEqual([
      { agentId: 's1', request: { objective: 'Bounded work', maxGoalRounds: 7 } },
      { agentId: 's1', ref: { id: 'goal-1', revision: 1 }, request: { maxGoalRounds: 9 } },
    ])
    await transport.close()
  })

  it('passes the current mixed prompt content through the unchanged session.prompt wire', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { accepted: true } })),
    )
    const transport = versionedTransport(adapter(fetch))
    const content = [
      { type: 'text', text: '请查看这张图' },
      { type: 'image', mediaType: 'image/png', data: 'aGk=', name: 'screen.png' },
    ]

    await expect(
      transport.request('session.prompt', {
        sessionId: 's1',
        mode: 'steer',
        content,
        clientTimeZone: 'Asia/Shanghai',
      }),
    ).resolves.toMatchObject({ result: { ok: true, value: { accepted: true } } })

    const request = requestBody(fetch.mock.calls[0]?.[1])
    expect(request).toMatchObject({ type: 'client-request', method: 'session/prompt' })
    expect(request.payload?.args?.request?.content).toEqual(content)
    await transport.close()
  })

  it('rejects a malformed session.list value and releases the probe transport', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: 'not-an-array' } })),
    )

    await expect(adapter(fetch).probe(candidate('0.1.2-alpha.5'))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('propagates caller cancellation through the alpha.5 probe', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined
          observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          })
        }),
    )

    const pending = adapter(fetch).probe(candidate('0.1.2-alpha.5'), controller.signal)
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(observedSignal?.aborted).toBe(true)
  })
})

function versionedTransport(adapter: Alpha5VersionAdapter): DshTransport {
  return adapter.createTransport(endpoint)
}
