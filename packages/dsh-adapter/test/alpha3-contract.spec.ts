import { describe, expect, it, vi } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { VersionedBackendProbe } from '../src/probe.js'
import { Alpha3VersionAdapter } from '../src/versions/alpha3/adapter.js'
import { callRpc } from '../src/versions/rc6/rpc.js'
import { candidate, endpoint, rpcResponse as response } from './support/contract-harness.js'

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
  it('does not use the exact-only alpha.3 implementation for an unknown future runtime', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(response(init, { ok: true, value: { items: [] } })),
    )
    const connected = await new VersionedBackendProbe([adapter(fetch)]).probe(candidate('0.1.2-alpha.6'))

    expect(connected).toBeUndefined()
    expect(fetch.mock.calls).toHaveLength(0)
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

  it('maps the alpha.3 subagent attachment-invalid vocabulary with its actionable reason', async () => {
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        response(init, {
          ok: false,
          error: {
            code: 'subagent/attachment-invalid',
            message: 'the selected model does not accept images',
            details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
          },
        }),
      ),
    )
    const transport = versionedTransport(adapter(fetch))

    await expect(
      callRpc(transport, 'subagent.prompt', { parentSessionId: 'p1', childSessionId: 'c1', content: [] }),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      message: 'The selected DSH model does not support image input.',
      context: {
        rpcCode: 'attachment-error',
        attachmentReason: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      },
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
