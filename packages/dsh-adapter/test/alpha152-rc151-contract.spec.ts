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

  it('surfaces the durable next-request model selection for the open session', () => {
    // rc.1 records a model switch as `model/selection` (the projection's
    // pending intent) before the next request header confirms it. A client
    // that drops the frame keeps showing the previous model until the next
    // prompt starts, so the selection must reach the configuration patch.
    expect(
      rc6Mapper.event('model/selection', {
        sessionId: 'session-1',
        data: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
      }),
    ).toEqual({
      type: 'session.configuration',
      sessionId: 'session-1',
      patch: {
        model: { providerId: 'deepseek', modelId: 'deepseek-chat', reasoningLevel: 'high' },
      },
    })
    // The pinned schema requires both identities. A partial frame must stay
    // opaque instead of half-clearing the visible model.
    expect(
      rc6Mapper.event('model/selection', { sessionId: 'session-1', data: { provider: 'deepseek' } }),
    ).toMatchObject({ type: 'unknown', name: 'model/selection' })
  })

  it('keeps rc.1 log-only audit frames opaque without leaking their payload', () => {
    // Every frame below is audit or bookkeeping in the pinned rc.1 contract,
    // and the state a user sees arrives through another channel: approvals and
    // questions as $events waterfalls, message feedback over the
    // messageFeedback/* RPCs, the queue over session/control, titles over
    // session/title. Mapping them here would invent a second source of truth.
    for (const name of [
      'agent/inbox/spliced',
      'approval/asked',
      'approval/decided',
      'feedback/record',
      'hook/invoked',
      'hook/result',
      'schedule/change',
      'session/end-seed',
      'session/title-llm-request',
      'subagent/descriptor',
    ])
      expect(rc6Mapper.event(name, { sessionId: 'session-1', data: { anything: true } })).toMatchObject({
        type: 'unknown',
        name,
        sessionId: 'session-1',
      })
    // The audit payload still crosses the adapter boundary, so the redaction
    // has to be the thing that keeps prompt material out of a raw row.
    const titleRequest = rc6Mapper.event('session/title-llm-request', {
      sessionId: 'session-1',
      data: { prompt: 'internal title prompt', keep: 'visible' },
    })
    expect(titleRequest).toMatchObject({ type: 'unknown' })
    expect(JSON.stringify(titleRequest)).not.toContain('internal title prompt')
    expect(JSON.stringify(titleRequest)).toContain('visible')
  })

  it('normalizes model-authored display text instead of dropping the event', () => {
    // The `present` tool's `description` and the `subagent` tool's
    // `description` are unconstrained model strings, so a line break is valid
    // upstream. These values are display text, not paths: rejecting them would
    // degrade the durable row into an unreadable frame and delete the
    // deliverable card or the child entry from the product.
    expect(
      rc6Mapper.event('deliverables/presented', {
        sessionId: 'session-1',
        data: {
          turn: 2,
          callId: 'call-present',
          files: [
            { path: 'artifacts/report.md', description: 'Final report\nwritten by the subagent' },
            { path: 'artifacts/notes.md', description: '\t' },
          ],
        },
      }),
    ).toEqual({
      type: 'deliverables.presented',
      sessionId: 'session-1',
      turn: 2,
      callId: 'call-present',
      files: [
        { path: 'artifacts/report.md', description: 'Final report written by the subagent' },
        { path: 'artifacts/notes.md' },
      ],
    })
    expect(
      rc6Mapper.event('subagent/catalog', {
        sessionId: 'session-1',
        data: {
          version: 0,
          childId: 'child-1',
          childCreatedAt: 42,
          mode: 'one-shot',
          label: 'Research\nchild',
        },
      }),
    ).toEqual({
      type: 'subagent.catalog.updated',
      sessionId: 'session-1',
      entry: { id: 'child-1', createdAt: 42, mode: 'one-shot', label: 'Research child' },
    })
    // Upstream types a continuable label as `z.string()`, so an empty one is a
    // valid fact. The child entry must survive it: the drawer falls back to the
    // child id when no display label is available.
    expect(
      rc6Mapper.event('subagent/catalog', {
        sessionId: 'session-1',
        data: { version: 0, childId: 'child-2', childCreatedAt: 43, mode: 'continuable', label: '   ' },
      }),
    ).toEqual({
      type: 'subagent.catalog.updated',
      sessionId: 'session-1',
      entry: { id: 'child-2', createdAt: 43, mode: 'continuable' },
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
