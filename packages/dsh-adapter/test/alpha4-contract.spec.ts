import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha4VersionAdapter } from '../src/versions/alpha4/adapter.js'
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

function adapter(fetch: typeof globalThis.fetch): Alpha4VersionAdapter {
  return new Alpha4VersionAdapter({
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  })
}

describe('DSH 0.1.2-alpha.4 Connection/Gateway contract', () => {
  it('selects only the exact alpha.4 runtime and keeps its independent identity', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const versioned = adapter(fetch)

    await expect(versioned.probe(candidate('0.1.2-alpha.4'))).resolves.toMatchObject({
      protocolVersion: 'alpha4',
      dshVersion: '0.1.2-alpha.4',
    })
    await expect(versioned.probe(candidate('0.1.2-alpha.3'))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('selects known alpha.4 exactly after the newer alpha.5 candidate declines it', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const connected = await new VersionedBackendProbe([
      new Alpha5VersionAdapter({
        requestTimeoutMs: 1_000,
        retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
        fetch,
      }),
      adapter(fetch),
    ]).probe(candidate('0.1.2-alpha.4'))

    expect(connected).toMatchObject({
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha4',
        dshVersion: '0.1.2-alpha.4',
        adapterId: 'dsh-0.1.2-alpha.4',
        compatibilityMode: 'exact',
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('retains the alpha Remote error mapper at the alpha.4 version boundary', async () => {
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

  it('rejects a malformed session.list value at the alpha.4 boundary', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: 'not-an-array' } })),
    )

    await expect(adapter(fetch).probe(candidate('0.1.2-alpha.4'))).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })
})

function versionedTransport(adapter: Alpha4VersionAdapter): DshTransport {
  return adapter.createTransport(endpoint)
}
