import { describe, expect, it, vi } from 'vitest'
import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from '../src/contracts.js'
import { isDshPackageVersion, isMalformedDshVersionHint, normalizeDshVersion } from '../src/contracts.js'
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

describe('DSH package version validation', () => {
  it('uses SemVer prerelease rules while accepting valid build metadata', () => {
    const withBuildMetadata = '0.1.7-rc.1+build.01'
    const malformedPrerelease = '0.1.7-rc.01'

    expect(isDshPackageVersion(withBuildMetadata)).toBe(true)
    expect(isMalformedDshVersionHint(withBuildMetadata)).toBe(false)
    expect(normalizeDshVersion(withBuildMetadata)).toBe(withBuildMetadata)
    expect(isDshPackageVersion(malformedPrerelease)).toBe(false)
    expect(isMalformedDshVersionHint(malformedPrerelease)).toBe(true)
  })
})

describe('VersionedBackendProbe version classification', () => {
  it('fails with DSH_INCOMPATIBLE when every exact adapter declines a known RC6 endpoint', async () => {
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

  it('tries the newest compatibility probe first for an unknown future runtime', async () => {
    const newest = compatibilityAdapter('newest', undefined, undefined, 20)
    const older = compatibilityAdapter(
      'older',
      {
        protocolVersion: 'known-contract',
        dshVersion: 'known-version',
        features: new Set(['session']),
      },
      undefined,
      10,
    )

    const connected = await new VersionedBackendProbe([newest, older]).probe({
      ...candidate(3949),
      runtimeVersion: '0.1.2-alpha.6',
    })

    expect(connected?.capabilities).toMatchObject({
      protocolVersion: 'known-contract',
      dshVersion: '0.1.2-alpha.6',
      adapterId: 'older',
      compatibilityMode: 'best-effort',
      featureProfile: { source: 'compatibility-fallback' },
    })
    expect(newest.probe.mock.calls).toHaveLength(0)
    expect(newest.probeCompatibility.mock.calls).toHaveLength(1)
    expect(older.probe.mock.calls).toHaveLength(0)
    expect(older.probeCompatibility.mock.calls).toHaveLength(1)
  })

  it('uses explicit compatibility priority instead of relying on adapter array order', async () => {
    const older = compatibilityAdapter(
      'older',
      {
        protocolVersion: 'older-contract',
        dshVersion: 'older',
        features: new Set(['session']),
      },
      undefined,
      10,
    )
    const newest = compatibilityAdapter(
      'newest',
      {
        protocolVersion: 'newest-contract',
        dshVersion: 'newest',
        features: new Set(['session']),
      },
      undefined,
      20,
    )

    const connected = await new VersionedBackendProbe([older, newest]).probe({
      ...candidate(3954),
      runtimeVersion: '0.1.2-alpha.6',
    })

    expect(connected?.capabilities.adapterId).toBe('newest')
    expect(newest.probeCompatibility.mock.calls).toHaveLength(1)
    expect(older.probeCompatibility.mock.calls).toHaveLength(0)
  })

  it('does not invoke a compatibility hook on an adapter that is not a fallback', async () => {
    const nonFallback = compatibilityAdapter(
      'non-fallback',
      {
        protocolVersion: 'wrong-contract',
        dshVersion: 'wrong-version',
        features: new Set(['session']),
      },
      undefined,
      100,
      false,
    )
    const fallback = compatibilityAdapter(
      'fallback',
      {
        protocolVersion: 'safe-contract',
        dshVersion: 'safe-version',
        features: new Set(['session']),
      },
      undefined,
      10,
      true,
    )

    const connected = await new VersionedBackendProbe([nonFallback, fallback]).probe({
      ...candidate(3955),
      runtimeVersion: '0.1.2-alpha.6',
    })

    expect(connected?.capabilities.adapterId).toBe('fallback')
    expect(nonFallback.probeCompatibility.mock.calls).toHaveLength(0)
    expect(fallback.probeCompatibility.mock.calls).toHaveLength(1)
  })

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

  it('does not strip build metadata into a pinned exact runtime identity', async () => {
    const exact = compatibilityAdapter(
      'exact-rc171',
      undefined,
      { protocolVersion: 'rc171', dshVersion: '0.1.7-rc.1', features: new Set(['session']) },
      100,
      false,
    )

    await expect(
      new VersionedBackendProbe([exact]).probe({
        ...candidate(3961),
        runtimeVersion: '0.1.7-rc.1+local-build',
      }),
    ).resolves.toBeUndefined()
    expect(exact.probe.mock.calls).toHaveLength(0)
    expect(exact.probeCompatibility.mock.calls).toHaveLength(0)
  })

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

  it('routes a missing runtime version only through an explicit fallback compatibility probe', async () => {
    const exactOnly = compatibilityAdapter(
      'exact-only',
      undefined,
      {
        protocolVersion: 'must-not-run',
        dshVersion: 'unexpected-exact',
        features: new Set(['session']),
      },
      100,
      false,
    )
    const adapter = compatibilityAdapter('legacy-fallback', {
      protocolVersion: 'legacy-contract',
      dshVersion: 'unknown',
      features: new Set(['session']),
      compatibilityMode: 'best-effort',
      compatibilityWarning: 'runtime version missing',
    })

    const versionedCandidate = candidate(3957)
    const unversionedCandidate: BackendCandidate = {
      endpoint: versionedCandidate.endpoint,
      source: versionedCandidate.source,
      confidence: versionedCandidate.confidence,
    }
    const connected = await new VersionedBackendProbe([exactOnly, adapter]).probe(unversionedCandidate)

    expect(connected?.capabilities).toMatchObject({
      dshVersion: 'unknown',
      adapterId: 'legacy-fallback',
      compatibilityMode: 'best-effort',
      featureProfile: { source: 'compatibility-fallback' },
    })
    expect(exactOnly.probe.mock.calls).toHaveLength(0)
    expect(exactOnly.probeCompatibility.mock.calls).toHaveLength(0)
    expect(adapter.probe.mock.calls).toHaveLength(0)
    expect(adapter.probeCompatibility.mock.calls).toHaveLength(1)
  })

  it('continues after a compatibility candidate reports an incompatible contract', async () => {
    const incompatible = compatibilityAdapter('incompatible', Promise.reject(incompatibleError()))
    const accepting = compatibilityAdapter('accepting', {
      protocolVersion: 'future-contract',
      dshVersion: 'ignored-by-selection',
      features: new Set(['session']),
    })

    const connected = await new VersionedBackendProbe([incompatible, accepting]).probe({
      ...candidate(3952),
      runtimeVersion: 'dsh-next-development',
    })

    expect(connected?.capabilities.adapterId).toBe('accepting')
    expect(incompatible.probeCompatibility.mock.calls).toHaveLength(1)
    expect(accepting.probeCompatibility.mock.calls).toHaveLength(1)
  })

  it('propagates cancellation from a compatibility probe without trying older adapters', async () => {
    const controller = new AbortController()
    const cancelled = compatibilityAdapter(
      'cancelled',
      Promise.reject(new DOMException('aborted', 'AbortError')),
    )
    const older = compatibilityAdapter('older', {
      protocolVersion: 'older-contract',
      dshVersion: 'older',
      features: new Set(),
    })

    const pending = new VersionedBackendProbe([cancelled, older]).probe(
      { ...candidate(3953), runtimeVersion: '0.1.2-alpha.6' },
      controller.signal,
    )
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(older.probeCompatibility.mock.calls).toHaveLength(0)
  })

  it('propagates a normalized cancellation from a compatibility probe', async () => {
    const cancelled = compatibilityAdapter(
      'cancelled',
      Promise.reject(new AppError({ code: 'REQUEST_CANCELLED', message: 'cancelled', retryable: false })),
    )
    const older = compatibilityAdapter('older', {
      protocolVersion: 'older-contract',
      dshVersion: 'older',
      features: new Set(),
    })

    await expect(
      new VersionedBackendProbe([cancelled, older]).probe({
        ...candidate(3956),
        runtimeVersion: '0.1.2-alpha.6',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(older.probeCompatibility.mock.calls).toHaveLength(0)
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
