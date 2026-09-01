import { describe, expect, it, vi } from 'vitest'
import type { BackendCapabilities, ConnectedBackend, DshBackend } from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from '../src/contracts.js'
import { VersionedBackendFactory } from '../src/backend-factory.js'

const endpoint = { host: '127.0.0.1' as const, port: 3955, baseUrl: 'http://127.0.0.1:3955' }

function adapter(
  id: string,
  supportedVersion: string,
  protocolVersion: string,
): DshVersionAdapter & {
  readonly createBackend: ReturnType<typeof vi.fn>
} {
  return {
    id,
    supportedVersion,
    protocolVersion,
    probe: vi.fn(() => Promise.resolve(undefined)),
    createTransport: vi.fn(() => ({}) as DshTransport),
    createBackend: vi.fn((backend: ConnectedBackend) =>
      Promise.resolve({ connection: backend, close: () => Promise.resolve() } as DshBackend),
    ),
  }
}

function connected(capabilities: BackendCapabilities): ConnectedBackend {
  return { endpoint, ownership: 'external', capabilities }
}

describe('VersionedBackendFactory compatibility adapter identity', () => {
  it('uses the adapter selected by an unknown-runtime compatibility probe', async () => {
    const selected = adapter('latest-known', '0.1.2-alpha.3', 'alpha3')
    const sameProtocol = adapter('same-protocol', '0.1.2-alpha.2', 'alpha3')
    const factory = new VersionedBackendFactory([sameProtocol, selected])

    await factory.connect(
      connected({
        dshVersion: '0.1.2-alpha.4',
        protocolVersion: 'alpha3',
        features: new Set(),
        adapterId: 'latest-known',
        compatibilityMode: 'best-effort',
      }),
    )

    expect(selected.createBackend.mock.calls).toHaveLength(1)
    expect(sameProtocol.createBackend.mock.calls).toHaveLength(0)
  })

  it('retains protocol-version selection for older connected-backend callers', async () => {
    const selected = adapter('protocol-adapter', 'known', 'known-protocol')
    const factory = new VersionedBackendFactory([selected])

    await factory.connect(
      connected({
        dshVersion: 'future',
        protocolVersion: 'known-protocol',
        features: new Set(),
      }),
    )

    expect(selected.createBackend.mock.calls).toHaveLength(1)
  })

  it('rejects a best-effort backend without the adapter identity from probing', async () => {
    const fallback = adapter('fallback', '0.1.0-rc.6', 'rc6')
    const factory = new VersionedBackendFactory([fallback])

    await expect(
      factory.connect(
        connected({
          dshVersion: '0.1.2-alpha.4',
          protocolVersion: 'rc6',
          features: new Set(),
          compatibilityMode: 'best-effort',
        }),
      ),
    ).rejects.toMatchObject({ code: 'DSH_INCOMPATIBLE' })
    expect(fallback.createBackend.mock.calls).toHaveLength(0)
  })

  it('rejects a stale best-effort adapter identity instead of falling back by protocol', async () => {
    const sameProtocol = adapter('same-protocol', '0.1.2-alpha.3', 'alpha3')
    const factory = new VersionedBackendFactory([sameProtocol])

    await expect(
      factory.connect(
        connected({
          dshVersion: '0.1.2-alpha.4',
          protocolVersion: 'alpha3',
          features: new Set(),
          adapterId: 'removed-adapter',
          compatibilityMode: 'best-effort',
        }),
      ),
    ).rejects.toMatchObject({ code: 'DSH_INCOMPATIBLE' })
    expect(sameProtocol.createBackend.mock.calls).toHaveLength(0)
  })
})
