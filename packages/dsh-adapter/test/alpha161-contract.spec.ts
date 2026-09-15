import { describe, expect, it, vi } from 'vitest'

import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { Alpha161VersionAdapter, type Alpha161AdapterOptions } from '../src/versions/alpha161/adapter.js'
import { validAlpha151SessionEvent } from '../src/versions/alpha151/session-wire.js'

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

function options(fetch: typeof globalThis.fetch): Alpha161AdapterOptions {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch,
  }
}

describe('DSH 0.1.6-alpha.1 contract seams', () => {
  it('selects the exact v3 adapter and keeps it out of compatibility fallback', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { items: [] })),
    )
    const adapter = new Alpha161VersionAdapter(options(fetch))

    await expect(adapter.probe(candidate('0.1.6-alpha.1'))).resolves.toMatchObject({
      protocolVersion: 'alpha161',
      dshVersion: '0.1.6-alpha.1',
    })
    await expect(adapter.probe(candidate('0.1.5-rc.2'))).resolves.toBeUndefined()
    await expect(adapter.probeCompatibility(candidate('0.1.6-alpha.1'))).resolves.toBeUndefined()
  })

  it('preserves the new image offload projection event as an opaque v3 event', () => {
    const wireEvent = {
      type: 'image/offload',
      seq: 3,
      time: 300,
      data: { targets: [{ seq: 2, imageIndexes: [0] }] },
    }

    expect(validAlpha151SessionEvent(wireEvent)).toBe(true)
    const mapped = rc6Mapper.event('image/offload', {
      sessionId: 'session-1',
      data: wireEvent.data,
    })
    expect(mapped).toMatchObject({
      type: 'unknown',
      sessionId: 'session-1',
      name: 'image/offload',
      payload: {
        sessionId: 'session-1',
        data: { targets: [{ seq: '[truncated]', imageIndexes: '[truncated]' }] },
      },
    })
  })

  it('does not let image offload acquire surface replacement semantics', () => {
    expect(
      validAlpha151SessionEvent({
        type: 'image/offload',
        seq: 3,
        time: 300,
        data: { targets: [{ seq: 2, imageIndexes: [0] }] },
        surfaceOp: 'append',
      }),
    ).toBe(false)
  })

  it('maps the alpha.1 tool failure reason without exposing the structured identity', () => {
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 'session-1',
      data: {
        callId: 'call-1',
        error: {
          name: 'ToolOutputError',
          code: 'INVALID_TOOL_OUTPUT',
          reason: '工具输出无法保存',
        },
        message: {
          content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }],
        },
      },
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'call-1', status: 'failed', error: '工具输出无法保存' },
    })
    expect(JSON.stringify(mapped)).not.toContain('ToolOutputError')
  })
})
