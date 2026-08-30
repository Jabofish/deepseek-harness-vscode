import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import { VersionedBackendProbe } from '../src/probe.js'

function candidate(port: number): BackendCandidate {
  return {
    endpoint: { host: '127.0.0.1', port, baseUrl: `http://127.0.0.1:${port}` },
    source: 'configured',
    confidence: 100,
  }
}

function incompatibleError(): AppError {
  return new AppError({
    code: 'DSH_INCOMPATIBLE',
    message: 'The endpoint did not report a compatible DSH host version.',
    retryable: false,
  })
}

describe('VersionedBackendProbe endpoint validation', () => {
  it('rejects a fractional loopback port before invoking any adapter', async () => {
    const adapter = {
      id: 'fixture',
      supportedVersion: 'fixture',
      probe: vi.fn(),
      createTransport: vi.fn(),
    }

    await expect(new VersionedBackendProbe([adapter]).probe(candidate(3939.5))).rejects.toMatchObject({
      code: 'INVALID_ENDPOINT',
    })
    expect(adapter.probe).not.toHaveBeenCalled()
  })
})

describe('VersionedBackendProbe version classification', () => {
  it('fails with DSH_INCOMPATIBLE when every adapter declines an unversioned DSH endpoint', async () => {
    const probe = vi.fn((): Promise<never> => Promise.reject(incompatibleError()))
    const adapter = { id: 'fixture', supportedVersion: 'fixture', probe, createTransport: vi.fn() }

    await expect(new VersionedBackendProbe([adapter, adapter]).probe(candidate(3941))).rejects.toMatchObject({
      code: 'DSH_INCOMPATIBLE',
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('succeeds when a later adapter accepts a candidate an earlier one reported incompatible', async () => {
    const declining = {
      id: 'declining',
      supportedVersion: 'declining',
      probe: vi.fn((): Promise<never> => Promise.reject(incompatibleError())),
      createTransport: vi.fn(),
    }
    const accepting = {
      id: 'accepting',
      supportedVersion: 'accepting',
      probe: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 'rc6',
          dshVersion: '0.1.0-rc.6',
          features: new Set(['host']),
        }),
      ),
      createTransport: vi.fn(),
    }

    const connected = await new VersionedBackendProbe([declining, accepting]).probe(candidate(3942))
    expect(connected?.capabilities.dshVersion).toBe('0.1.0-rc.6')
  })

  it('keeps reporting an unreachable endpoint when no adapter classifies it as DSH', async () => {
    const declining = {
      id: 'declining',
      supportedVersion: 'declining',
      probe: vi.fn(() => Promise.resolve(undefined)),
      createTransport: vi.fn(),
    }

    expect(await new VersionedBackendProbe([declining]).probe(candidate(3943))).toBeUndefined()
  })
})
