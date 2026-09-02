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
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId?: string }
  return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

function requestBody(init: RequestInit | undefined): {
  readonly type?: string
  readonly method?: string
  readonly payload?: {
    readonly args?: { readonly request?: { readonly content?: unknown } }
  }
} {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return JSON.parse(init.body) as {
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
