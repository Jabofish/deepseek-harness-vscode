import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, ConnectedBackend } from '@dsh-vscode/domain'

import { VersionedBackendFactory } from '../src/backend-factory.js'
import { Rc6VersionAdapter } from '../src/versions/rc6/adapter.js'
import { Rc7VersionAdapter } from '../src/versions/rc7/adapter.js'
import { Rc8VersionAdapter } from '../src/versions/rc8/adapter.js'
import { Rc11VersionAdapter } from '../src/versions/rc11/adapter.js'
import { Rc12VersionAdapter } from '../src/versions/rc12/adapter.js'

const endpoint = { host: '127.0.0.1' as const, port: 3939, baseUrl: 'http://127.0.0.1:3939' }
const candidate: BackendCandidate = { endpoint, source: 'configured', confidence: 100 }

function options(value: { readonly home?: string }): ConstructorParameters<typeof Rc8VersionAdapter>[0] {
  return {
    requestTimeoutMs: 1_000,
    retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
    fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Response(init?.body ?? null).text()
      const request = JSON.parse(body) as { readonly rpcId?: string }
      return new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: request.rpcId,
          result: {
            ok: true,
            value: {
              version: '0.0.1',
              cwd: 'fixture',
              attachedSessions: 0,
              canOpenPath: true,
              ...(value.home === undefined ? {} : { home: value.home }),
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  }
}

function connected(version: string, protocolVersion = 'rc11'): ConnectedBackend {
  return {
    endpoint,
    ownership: 'external',
    capabilities: { protocolVersion, dshVersion: version, features: new Set() },
  }
}

describe('DeepSeek Harness rc.1/rc.2 compatibility contract', () => {
  it('selects the exact rc.1 adapter and keeps rc.8 from claiming that version', async () => {
    const rc11 = new Rc11VersionAdapter(options({ home: 'fixture-home' }))
    await expect(rc11.probe({ ...candidate, runtimeVersion: '0.1.1-rc.1' })).resolves.toMatchObject({
      protocolVersion: 'rc11',
      dshVersion: '0.1.1-rc.1',
    })
    await expect(
      new Rc8VersionAdapter(options({ home: 'fixture-home' })).probe({
        ...candidate,
        runtimeVersion: '0.1.1-rc.1',
      }),
    ).resolves.toBeUndefined()
  })

  it('selects the exact rc.2 adapter and keeps rc.1 from sending its removed field', async () => {
    const rc12 = new Rc12VersionAdapter(options({ home: 'fixture-home' }))
    await expect(rc12.probe({ ...candidate, runtimeVersion: '0.1.1-rc.2' })).resolves.toMatchObject({
      protocolVersion: 'rc12',
      dshVersion: '0.1.1-rc.2',
    })
    await expect(
      new Rc11VersionAdapter(options({ home: 'fixture-home' })).probe({
        ...candidate,
        runtimeVersion: '0.1.1-rc.2',
      }),
    ).resolves.toBeUndefined()
  })

  it('retains exact legacy adapters and unknown-version warning fallback', async () => {
    const adapters = [
      new Rc12VersionAdapter(options({ home: 'fixture-home' })),
      new Rc11VersionAdapter(options({ home: 'fixture-home' })),
      new Rc8VersionAdapter(options({ home: 'fixture-home' })),
      new Rc7VersionAdapter(options({})),
      new Rc6VersionAdapter(options({})),
    ] as const
    const factory = new VersionedBackendFactory(adapters)
    for (const [version, protocolVersion] of [
      ['0.1.0-rc.6', 'rc6'],
      ['0.1.0-rc.7', 'rc7'],
      ['0.1.0-rc.8', 'rc8'],
      ['0.1.1-rc.1', 'rc11'],
      ['0.1.1-rc.2', 'rc12'],
    ] as const) {
      const backend = await factory.connect(connected(version, protocolVersion))
      expect(backend.connection.capabilities.dshVersion).toBe(version)
      await backend.close()
    }
    const future = await factory.connect(connected('0.1.2-rc.1', 'rc8'))
    expect(future.connection.capabilities.dshVersion).toBe('0.1.2-rc.1')
    await future.close()
  })
})
