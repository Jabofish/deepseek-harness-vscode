import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { Alpha132VersionAdapter, type Alpha132AdapterOptions } from '../src/versions/alpha132/adapter.js'

const endpoint: BackendEndpoint = {
  host: '127.0.0.1',
  port: 4567,
  baseUrl: 'http://127.0.0.1:4567',
}

function candidate(runtimeVersion: string): BackendCandidate {
  return { endpoint, source: 'configured', runtimeVersion, confidence: 1 }
}

function response(init: RequestInit | undefined, value: unknown): Response {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  const request = JSON.parse(init.body) as { readonly rpcId?: string }
  return new Response(
    JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } }),
    { headers: { 'content-type': 'application/json' } },
  )
}

function options(fetch: typeof globalThis.fetch): Alpha132AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

describe('DSH 0.1.3-alpha.2 contract', () => {
  it('selects the released alpha.2 adapter exactly and refuses compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha132VersionAdapter(options(fetch))

    await expect(adapter.probe(candidate('0.1.3-alpha.2'))).resolves.toMatchObject({
      protocolVersion: 'alpha132',
      dshVersion: '0.1.3-alpha.2',
      subagentImagePrompts: true,
    })
    await expect(adapter.probe(candidate('0.1.3-alpha.1'))).resolves.toBeUndefined()
    await expect(adapter.probeCompatibility(candidate('0.1.3-alpha.3'))).resolves.toBeUndefined()
  })

  it('enables the required alpha.2 subagent delivery discriminator through the assembled backend', async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
      const request = JSON.parse(init.body) as Record<string, unknown>
      requests.push(request)
      const value =
        request.method === 'subagents/list'
          ? {
              entries: [
                {
                  kind: 'child',
                  id: 'child',
                  label: 'worker',
                  activity: 'running',
                  hasChildren: false,
                  mode: 'continuable',
                },
              ],
              parentAvailable: true,
            }
          : { messageId: 'message-1' }
      return Promise.resolve(response(init, value))
    })
    const adapter = new Alpha132VersionAdapter(options(fetch))
    const backend = await adapter.createBackend({
      endpoint,
      ownership: 'external',
      capabilities: {
        protocolVersion: 'alpha132',
        dshVersion: '0.1.3-alpha.2',
        features: new Set(),
        subagentImagePrompts: true,
      },
    })

    await backend.subagents.list('parent')
    await backend.subagents.send('child', 'steer now', [], 'steer')

    const prompt = requests.find((request) => request.method === 'subagents/prompt')
    expect(prompt).toMatchObject({ payload: { args: { request: { delivery: 'steer' } } } })
    await backend.close()
  })
})
