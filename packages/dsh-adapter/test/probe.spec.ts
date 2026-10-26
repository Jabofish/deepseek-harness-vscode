import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from '../src/contracts.js'

import { VersionedBackendProbe } from '../src/probe.js'

function candidate(port: number): BackendCandidate {
  return {
    endpoint: { host: '127.0.0.1', port, baseUrl: `http://127.0.0.1:${port}` },
    source: 'configured',
    runtimeVersion: '0.1.0-rc.6',
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
  it('does not call exact-only adapters for an unknown runtime', async () => {
    const exactOnly = {
      id: 'exact-only',
      supportedVersion: '0.1.2-alpha.3',
      probe: vi.fn(() => Promise.resolve(undefined)),
      createTransport: vi.fn(),
    }

    await expect(
      new VersionedBackendProbe([exactOnly]).probe({
        ...candidate(3950),
        runtimeVersion: '0.1.2-alpha.6',
      }),
    ).resolves.toBeUndefined()
    expect(exactOnly.probe.mock.calls).toHaveLength(0)
  })

  it.each(['0.1.7-rc.1 trailing', '0.1.7-rc.01'])(
    'refuses malformed semver hint %s instead of selecting an exact or compatibility wire',
    async (runtimeVersion) => {
      const exact = compatibilityAdapter(
        'exact-rc171',
        undefined,
        { protocolVersion: 'rc171', dshVersion: '0.1.7-rc.1', features: new Set(['session']) },
        100,
        false,
      )
      const fallback = compatibilityAdapter(
        'safe-fallback',
        { protocolVersion: 'fallback', dshVersion: 'fallback', features: new Set(['session']) },
        undefined,
        10,
        true,
      )

      const fetch = vi.fn<typeof globalThis.fetch>()

      await expect(
        new VersionedBackendProbe([exact, fallback], { fetch }).probe({
          ...candidate(3960),
          runtimeVersion,
        }),
      ).resolves.toBeUndefined()
      expect(exact.probe.mock.calls).toHaveLength(0)
      expect(exact.probeCompatibility.mock.calls).toHaveLength(0)
      expect(fallback.probe.mock.calls).toHaveLength(0)
      expect(fallback.probeCompatibility.mock.calls).toHaveLength(0)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('keeps exact probing for a known runtime and never enters compatibility mode', async () => {
    const adapter = compatibilityAdapter('dsh-0.1.2-alpha.3', undefined, {
      protocolVersion: 'alpha3',
      dshVersion: '0.1.2-alpha.3',
      features: new Set(['session']),
    })

    const connected = await new VersionedBackendProbe([adapter]).probe({
      ...candidate(3951),
      runtimeVersion: '0.1.2-alpha.3',
    })

    expect(connected?.capabilities).toMatchObject({
      dshVersion: '0.1.2-alpha.3',
      adapterId: 'dsh-0.1.2-alpha.3',
      compatibilityMode: 'exact',
    })
    expect(adapter.probe.mock.calls).toHaveLength(1)
    expect(adapter.probeCompatibility.mock.calls).toHaveLength(0)
  })

  it('stops before the next adapter when cancellation arrives between probes', async () => {
    const controller = new AbortController()
    const first = {
      id: 'first',
      supportedVersion: 'first',
      compatibilityPriority: 20,
      fallback: true,
      probe: vi.fn(() => Promise.resolve(undefined)),
      probeCompatibility: vi.fn(() => {
        controller.abort()
        return Promise.resolve(undefined)
      }),
      createTransport: vi.fn(() => ({}) as DshTransport),
    }
    const second = compatibilityAdapter('second', {
      protocolVersion: 'second-contract',
      dshVersion: 'second',
      features: new Set(),
    })

    await expect(
      new VersionedBackendProbe([first, second]).probe(
        { ...candidate(3958), runtimeVersion: '0.1.2-alpha.6' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(second.probeCompatibility.mock.calls).toHaveLength(0)
  })

  it('does not let an already-cancelled caller reach an adapter when no pre-flight fetch is configured', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = compatibilityAdapter('adapter', {
      protocolVersion: 'contract',
      dshVersion: 'version',
      features: new Set(),
    })

    await expect(
      new VersionedBackendProbe([adapter]).probe(
        { ...candidate(3959), runtimeVersion: '0.1.2-alpha.6' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapter.probeCompatibility.mock.calls).toHaveLength(0)
  })
})

function compatibilityAdapter(
  id: string,
  result: BackendCapabilities | undefined | Promise<BackendCapabilities | undefined>,
  exactResult: BackendCapabilities | undefined = undefined,
  compatibilityPriority = 0,
  fallback = true,
): DshVersionAdapter & {
  readonly probe: ReturnType<typeof vi.fn>
  readonly probeCompatibility: ReturnType<typeof vi.fn>
} {
  return {
    id,
    supportedVersion: id,
    compatibilityPriority,
    fallback,
    probe: vi.fn(() => Promise.resolve(exactResult)),
    probeCompatibility: vi.fn(() => Promise.resolve(result)),
    createTransport: vi.fn(() => ({}) as DshTransport),
  }
}

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
})
