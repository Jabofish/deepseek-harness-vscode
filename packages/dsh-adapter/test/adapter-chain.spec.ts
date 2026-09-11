import { describe, expect, it } from 'vitest'

import {
  Alpha1VersionAdapter,
  Alpha2VersionAdapter,
  Alpha3VersionAdapter,
  Alpha4VersionAdapter,
  Alpha5VersionAdapter,
  Alpha13VersionAdapter,
  Alpha132VersionAdapter,
  Alpha151VersionAdapter,
  Alpha152VersionAdapter,
  AlphaVersionAdapter,
  LegacyRc1VersionAdapter,
  LegacyRc2VersionAdapter,
  LegacyRc5VersionAdapter,
  Rc02VersionAdapter,
  Rc03VersionAdapter,
  Rc6VersionAdapter,
  Rc7VersionAdapter,
  Rc8VersionAdapter,
  Rc11VersionAdapter,
  Rc12VersionAdapter,
  Rc13VersionAdapter,
  Rc151VersionAdapter,
  Rc152VersionAdapter,
  SUPPORTED_DSH_VERSIONS,
} from '../src/index.js'

const options = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
}

describe('version adapter family chains', () => {
  it('has exactly one concrete adapter for every supported release identity', () => {
    const adapters = [
      new LegacyRc1VersionAdapter(options),
      new LegacyRc2VersionAdapter(options),
      new LegacyRc5VersionAdapter(options),
      new Rc02VersionAdapter(options),
      new Rc03VersionAdapter(options),
      new Rc6VersionAdapter(options),
      new Rc7VersionAdapter(options),
      new Rc8VersionAdapter(options),
      new Rc11VersionAdapter(options),
      new Rc12VersionAdapter(options),
      new Rc13VersionAdapter(options),
      new Alpha1VersionAdapter(options),
      new Alpha2VersionAdapter(options),
      new Alpha3VersionAdapter(options),
      new Alpha4VersionAdapter(options),
      new Alpha5VersionAdapter(options),
      new Alpha13VersionAdapter(options),
      new Alpha132VersionAdapter(options),
      new Alpha151VersionAdapter(options),
      new Alpha152VersionAdapter(options),
      new Rc151VersionAdapter(options),
      new Rc152VersionAdapter(options),
    ]

    expect(adapters.map((adapter) => adapter.supportedVersion)).toEqual([...SUPPORTED_DSH_VERSIONS])
    expect(adapters.map((adapter) => adapter.id)).toEqual(
      SUPPORTED_DSH_VERSIONS.map((version) => `dsh-${version}`),
    )
    expect(new Set(adapters.map((adapter) => adapter.supportedVersion)).size).toBe(adapters.length)
  })

  it('keeps release identities and newest-first priorities monotonic', () => {
    const legacyRc1 = new LegacyRc1VersionAdapter(options)
    const legacyRc2 = new LegacyRc2VersionAdapter(options)
    const legacyRc5 = new LegacyRc5VersionAdapter(options)
    const rc02 = new Rc02VersionAdapter(options)
    const rc03 = new Rc03VersionAdapter(options)
    const rc6 = new Rc6VersionAdapter(options)
    const rc7 = new Rc7VersionAdapter(options)
    const rc8 = new Rc8VersionAdapter(options)
    const rc11 = new Rc11VersionAdapter(options)
    const rc12 = new Rc12VersionAdapter(options)
    const rc13 = new Rc13VersionAdapter(options)

    expect(rc7).toBeInstanceOf(Rc6VersionAdapter)
    expect(rc8).toBeInstanceOf(Rc7VersionAdapter)
    expect(rc11).toBeInstanceOf(Rc8VersionAdapter)
    expect(rc12).toBeInstanceOf(Rc11VersionAdapter)
    expect(rc13).toBeInstanceOf(Alpha5VersionAdapter)
    expect(
      [legacyRc1, legacyRc2, legacyRc5, rc02, rc03, rc6, rc7, rc8, rc11, rc12, rc13].map(
        (adapter) => adapter.compatibilityPriority,
      ),
    ).toEqual([10, 15, 20, 25, 27, 30, 40, 50, 60, 70, 125])
    expect(
      [legacyRc1, legacyRc2, legacyRc5, rc02, rc03, rc6, rc7, rc8, rc11, rc12, rc13].map(
        (adapter) => adapter.protocolVersion,
      ),
    ).toEqual([
      'legacy-rc1',
      'legacy-rc2',
      'legacy-rc5',
      'rc02',
      'rc03',
      'rc6',
      'rc7',
      'rc8',
      'rc11',
      'rc12',
      'rc13',
    ])
    expect(legacyRc1).toBeInstanceOf(Rc6VersionAdapter)
    expect(legacyRc2).toBeInstanceOf(LegacyRc1VersionAdapter)
    expect(legacyRc5).toBeInstanceOf(Rc6VersionAdapter)
    expect(rc02).toBeInstanceOf(LegacyRc5VersionAdapter)
    expect(rc03).toBeInstanceOf(Rc02VersionAdapter)
    expect(rc6.fallback).toBe(true)
    expect(legacyRc1.fallback).toBe(false)
    expect(legacyRc2.fallback).toBe(false)
    expect(legacyRc5.fallback).toBe(false)
    expect(rc02.fallback).toBe(false)
    expect(rc03.fallback).toBe(false)
    expect(rc13.fallback).toBe(false)
  })

  it('keeps the alpha chain linear without crossing the rc transport boundary', () => {
    const alpha1 = new Alpha1VersionAdapter(options)
    const alpha2 = new Alpha2VersionAdapter(options)
    const alpha3 = new Alpha3VersionAdapter(options)
    const alpha4 = new Alpha4VersionAdapter(options)
    const alpha5 = new Alpha5VersionAdapter(options)
    const alpha13 = new Alpha13VersionAdapter(options)
    const alpha132 = new Alpha132VersionAdapter(options)
    const alpha151 = new Alpha151VersionAdapter(options)
    const alpha152 = new Alpha152VersionAdapter(options)
    const rc151 = new Rc151VersionAdapter(options)
    const rc152 = new Rc152VersionAdapter(options)

    expect(alpha2).toBeInstanceOf(Alpha1VersionAdapter)
    expect(alpha3).toBeInstanceOf(Alpha2VersionAdapter)
    expect(alpha4).toBeInstanceOf(Alpha3VersionAdapter)
    expect(alpha5).toBeInstanceOf(Alpha4VersionAdapter)
    expect(alpha13).toBeInstanceOf(Alpha5VersionAdapter)
    expect(alpha132).toBeInstanceOf(Alpha13VersionAdapter)
    expect(alpha151).toBeInstanceOf(Alpha132VersionAdapter)
    expect(alpha152).toBeInstanceOf(Alpha151VersionAdapter)
    expect(rc151).toBeInstanceOf(Alpha152VersionAdapter)
    expect(rc152).toBeInstanceOf(Rc151VersionAdapter)
    expect(alpha1).not.toBeInstanceOf(Rc6VersionAdapter)
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13, alpha132, alpha151, alpha152, rc151, rc152].map(
        (adapter) => adapter.supportedVersion,
      ),
    ).toEqual([
      '0.1.2-alpha.1',
      '0.1.2-alpha.2',
      '0.1.2-alpha.3',
      '0.1.2-alpha.4',
      '0.1.2-alpha.5',
      '0.1.3-alpha.1',
      '0.1.3-alpha.2',
      '0.1.5-alpha.1',
      '0.1.5-alpha.2',
      '0.1.5-rc.1',
      '0.1.5-rc.2',
    ])
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13, alpha132, alpha151, alpha152, rc151, rc152].map(
        (adapter) => adapter.compatibilityPriority,
      ),
    ).toEqual([80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180])
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13, alpha132, alpha151, alpha152, rc151, rc152].map(
        (adapter) => adapter.protocolVersion,
      ),
    ).toEqual([
      'alpha1',
      'alpha2',
      'alpha3',
      'alpha4',
      'alpha5',
      'alpha13',
      'alpha132',
      'alpha151',
      'alpha152',
      'rc151',
      'rc152',
    ])
    expect(alpha5.fallback).toBe(true)
    expect(alpha13.fallback).toBe(false)
    expect(alpha151.fallback).toBe(false)
    expect(alpha152.fallback).toBe(false)
    expect(rc151.fallback).toBe(false)
    expect(rc152.fallback).toBe(false)
  })

  it('retains the old alpha family name as a compatibility alias only', () => {
    expect(AlphaVersionAdapter).toBe(Alpha1VersionAdapter)
  })
})
