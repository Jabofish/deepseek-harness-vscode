import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha3VersionAdapter } from '../src/versions/alpha3/adapter.js'
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

function adapter(fetch: typeof globalThis.fetch): Alpha3VersionAdapter {
  return new Alpha3VersionAdapter({
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  })
}

describe('DSH 0.1.2-alpha.3 Connection/Gateway contract', () => {
  it('selects only the exact alpha.3 runtime and keeps its protocol identity', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const versioned = adapter(fetch)

    await expect(versioned.probe(candidate('0.1.2-alpha.3'))).resolves.toMatchObject({
      protocolVersion: 'alpha3',
      dshVersion: '0.1.2-alpha.3',
    })
    await expect(versioned.probe(candidate('0.1.2-alpha.2'))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('uses alpha.3 as the newest verified implementation for an unknown future runtime', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const connected = await new VersionedBackendProbe([adapter(fetch)]).probe(candidate('0.1.2-alpha.4'))

    expect(connected).toMatchObject({
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha3',
        dshVersion: '0.1.2-alpha.4',
        adapterId: 'dsh-0.1.2-alpha.3',
        compatibilityMode: 'best-effort',
        featureProfile: { source: 'compatibility-fallback' },
      },
    })
    expect(connected?.capabilities.compatibilityWarning).toContain('0.1.2-alpha.4')
  })

  it('retains alpha.2 namespaced error mapping while using the alpha.3 entry point', async () => {
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

  it('passes mixed prompt content through for alpha.3 attachment admission', async () => {
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
})

function versionedTransport(adapter: Alpha3VersionAdapter): DshTransport {
  return adapter.createTransport(endpoint)
}
