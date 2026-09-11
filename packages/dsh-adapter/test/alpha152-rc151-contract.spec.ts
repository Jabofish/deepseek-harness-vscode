import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Alpha152VersionAdapter, type Alpha152AdapterOptions } from '../src/versions/alpha152/adapter.js'
import { Rc151VersionAdapter } from '../src/versions/rc151/adapter.js'
import { Rc152VersionAdapter } from '../src/versions/rc152/adapter.js'

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

function options(fetch: typeof globalThis.fetch): Alpha152AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

describe('DSH 0.1.5-alpha.2 and 0.1.5-rc.1/rc.2 contract seams', () => {
  it('selects each v3 release exactly and keeps both out of compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const alpha152 = new Alpha152VersionAdapter(options(fetch))
    const rc151 = new Rc151VersionAdapter(options(fetch))
    const rc152 = new Rc152VersionAdapter(options(fetch))

    await expect(alpha152.probe(candidate('0.1.5-alpha.2'))).resolves.toMatchObject({
      protocolVersion: 'alpha152',
      dshVersion: '0.1.5-alpha.2',
    })
    await expect(rc151.probe(candidate('0.1.5-rc.1'))).resolves.toMatchObject({
      protocolVersion: 'rc151',
      dshVersion: '0.1.5-rc.1',
    })
    await expect(rc151.probe(candidate('0.1.5-alpha.2'))).resolves.toBeUndefined()
    await expect(rc151.probeCompatibility(candidate('0.1.5-rc.1'))).resolves.toBeUndefined()
    await expect(rc152.probe(candidate('0.1.5-rc.2'))).resolves.toMatchObject({
      protocolVersion: 'rc152',
      dshVersion: '0.1.5-rc.2',
    })
    await expect(rc152.probe(candidate('0.1.5-rc.1'))).resolves.toBeUndefined()
    await expect(rc152.probeCompatibility(candidate('0.1.5-rc.2'))).resolves.toBeUndefined()
  })

  it('maps explicit file deliveries and parent catalog facts into bounded domain events', () => {
    expect(
      rc6Mapper.event('deliverables/presented', {
        sessionId: 'session-1',
        data: {
          turn: 1,
          callId: 'call-present',
          files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
        },
      }),
    ).toEqual({
      type: 'deliverables.presented',
      sessionId: 'session-1',
      turn: 1,
      callId: 'call-present',
      files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
    })
    expect(
      rc6Mapper.event('subagent/catalog', {
        sessionId: 'session-1',
        data: {
          version: 0,
          childId: 'child-1',
          childCreatedAt: 42,
          mode: 'continuable',
          label: 'Research child',
        },
      }),
    ).toEqual({
      type: 'subagent.catalog.updated',
      sessionId: 'session-1',
      entry: { id: 'child-1', createdAt: 42, mode: 'continuable', label: 'Research child' },
    })
  })

  it('fails closed for malformed delivery and catalog payloads', () => {
    expect(() =>
      rc6Mapper.event('deliverables/presented', {
        sessionId: 'session-1',
        data: { turn: 1, callId: 'call-present', files: [{ path: 'bad\u0000path' }] },
      }),
    ).toThrow(/Malformed deliverables\/presented path/u)
    expect(() =>
      rc6Mapper.event('subagent/catalog', {
        sessionId: 'session-1',
        data: { version: 0, childId: 'child-1', childCreatedAt: 42, mode: 'continuable' },
      }),
    ).toThrow(/Malformed subagent\/catalog continuable label/u)
  })
})
