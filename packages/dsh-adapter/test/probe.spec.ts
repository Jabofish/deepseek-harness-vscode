import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport } from '../src/contracts.js'
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

describe('VersionedBackendProbe reachability pre-flight', () => {
  // Property-signature function types (instead of DshVersionAdapter's method
  // syntax) keep the `expect(adapter.probe)` references lint-clean.
  function fixtureAdapter(id: string): {
    id: string
    supportedVersion: string
    probe: (candidate: BackendCandidate, signal?: AbortSignal) => Promise<BackendCapabilities | undefined>
    createTransport: (endpoint: BackendEndpoint) => DshTransport
  } {
    return {
      id,
      supportedVersion: id,
      probe: vi.fn((_candidate: BackendCandidate, _signal?: AbortSignal) => Promise.resolve(undefined)),
      createTransport: vi.fn(),
    }
  }

  it('declines a refusing endpoint without invoking any adapter', async () => {
    const adapter = fixtureAdapter('fixture')
    const probe = new VersionedBackendProbe([adapter], {
      fetch: vi.fn(() => Promise.reject(new TypeError('fetch failed ECONNREFUSED'))),
    })

    expect(await probe.probe(candidate(3944))).toBeUndefined()
    expect(adapter.probe).not.toHaveBeenCalled()
  })

  it('runs the adapter chain when the endpoint answers, whatever the status', async () => {
    const declining = fixtureAdapter('declining')
    const probe = new VersionedBackendProbe([declining], {
      fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    })

    expect(await probe.probe(candidate(3945))).toBeUndefined()
    expect(declining.probe).toHaveBeenCalledTimes(1)
  })

  it('declines an endpoint whose pre-flight exceeds its own timeout', async () => {
    const adapter = fixtureAdapter('fixture')
    const probe = new VersionedBackendProbe([adapter], {
      fetch: vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
              once: true,
            })
          }),
      ),
      preflightTimeoutMs: 10,
    })

    expect(await probe.probe(candidate(3946))).toBeUndefined()
    expect(adapter.probe).not.toHaveBeenCalled()
  })

  it('propagates the caller cancellation raised during the pre-flight', async () => {
    const adapter = fixtureAdapter('fixture')
    const controller = new AbortController()
    const probe = new VersionedBackendProbe([adapter], {
      fetch: vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
              once: true,
            })
          }),
      ),
    })

    const pending = probe.probe(candidate(3947), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapter.probe).not.toHaveBeenCalled()
  })

  it('still surfaces DSH_INCOMPATIBLE from the adapter chain after a live pre-flight', async () => {
    const incompatible = {
      id: 'incompatible',
      supportedVersion: 'incompatible',
      probe: vi.fn((): Promise<never> => Promise.reject(incompatibleError())),
      createTransport: vi.fn(),
    }
    const probe = new VersionedBackendProbe([incompatible], {
      fetch: vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    })

    await expect(probe.probe(candidate(3948))).rejects.toMatchObject({ code: 'DSH_INCOMPATIBLE' })
  })
})
