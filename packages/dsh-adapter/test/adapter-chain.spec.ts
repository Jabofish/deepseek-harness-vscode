import { describe, expect, it } from 'vitest'

import {
  Alpha1VersionAdapter,
  Alpha2VersionAdapter,
  Alpha3VersionAdapter,
  Alpha4VersionAdapter,
  Alpha5VersionAdapter,
  Alpha13VersionAdapter,
  AlphaVersionAdapter,
  Rc6VersionAdapter,
  Rc7VersionAdapter,
  Rc8VersionAdapter,
  Rc11VersionAdapter,
  Rc12VersionAdapter,
  Rc13VersionAdapter,
} from '../src/index.js'

const options = {
  requestTimeoutMs: 1_000,
  retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
  fetch: globalThis.fetch,
}

describe('version adapter family chains', () => {
  it('keeps release identities and newest-first priorities monotonic', () => {
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
    expect([rc6, rc7, rc8, rc11, rc12, rc13].map((adapter) => adapter.compatibilityPriority)).toEqual([
      30, 40, 50, 60, 70, 125,
    ])
    expect([rc6, rc7, rc8, rc11, rc12, rc13].map((adapter) => adapter.protocolVersion)).toEqual([
      'rc6',
      'rc7',
      'rc8',
      'rc11',
      'rc12',
      'rc13',
    ])
  })

  it('keeps the alpha chain linear without crossing the rc transport boundary', () => {
    const alpha1 = new Alpha1VersionAdapter(options)
    const alpha2 = new Alpha2VersionAdapter(options)
    const alpha3 = new Alpha3VersionAdapter(options)
    const alpha4 = new Alpha4VersionAdapter(options)
    const alpha5 = new Alpha5VersionAdapter(options)
    const alpha13 = new Alpha13VersionAdapter(options)

    expect(alpha2).toBeInstanceOf(Alpha1VersionAdapter)
    expect(alpha3).toBeInstanceOf(Alpha2VersionAdapter)
    expect(alpha4).toBeInstanceOf(Alpha3VersionAdapter)
    expect(alpha5).toBeInstanceOf(Alpha4VersionAdapter)
    expect(alpha13).toBeInstanceOf(Alpha5VersionAdapter)
    expect(alpha1).not.toBeInstanceOf(Rc6VersionAdapter)
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13].map((adapter) => adapter.supportedVersion),
    ).toEqual([
      '0.1.2-alpha.1',
      '0.1.2-alpha.2',
      '0.1.2-alpha.3',
      '0.1.2-alpha.4',
      '0.1.2-alpha.5',
      '0.1.3-alpha.1',
    ])
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13].map((adapter) => adapter.compatibilityPriority),
    ).toEqual([80, 90, 100, 110, 120, 130])
    expect(
      [alpha1, alpha2, alpha3, alpha4, alpha5, alpha13].map((adapter) => adapter.protocolVersion),
    ).toEqual(['alpha1', 'alpha2', 'alpha3', 'alpha4', 'alpha5', 'alpha13'])
  })

  it('retains the old alpha family name as a compatibility alias only', () => {
    expect(AlphaVersionAdapter).toBe(Alpha1VersionAdapter)
  })
})
