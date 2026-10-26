import { describe, expect, it } from 'vitest'

import { deriveFeatureCapabilityProfile } from '../src/feature-capabilities.js'

const base = {
  protocolVersion: 'rc12',
  features: new Set(['host', 'workspace', 'session', 'events']),
}

describe('staged feature capability profile', () => {
  it('enables timed questions only when the exact pinned runtime exposes the new Remote', () => {
    const rc202 = deriveFeatureCapabilityProfile({
      protocolVersion: 'rc202',
      dshVersion: '0.2.0-rc.2',
      features: new Set(['host', 'workspace', 'session', 'events', 'user-questions']),
    })
    expect(rc202.capabilities['UQ-01']).toMatchObject({
      state: 'verified-contract',
      upstream: 'verified-contract',
    })

    const unknown = deriveFeatureCapabilityProfile({
      protocolVersion: 'rc202',
      dshVersion: '0.2.1-next',
      features: new Set(['session', 'user-questions']),
      compatibilityWarning: 'unknown runtime',
    })
    expect(unknown.capabilities['UQ-01']).toMatchObject({
      state: 'compatibility-fallback',
      upstream: 'compatibility-fallback',
    })
  })

  it('downgrades unknown runtimes and reports missing upstream prerequisites', () => {
    const fallback = deriveFeatureCapabilityProfile({
      ...base,
      dshVersion: '0.1.9-next',
      compatibilityWarning: 'unknown runtime',
    })
    expect(fallback.source).toBe('compatibility-fallback')
    expect(fallback.capabilities['ED-01'].state).toBe('compatibility-fallback')
    expect(fallback.capabilities['NAV-01'].state).toBe('compatibility-fallback')
    expect(fallback.capabilities['SY-01'].state).toBe('verified-contract')

    const missing = deriveFeatureCapabilityProfile({
      ...base,
      dshVersion: '0.1.1-rc.2',
      features: new Set(['session']),
    })
    expect(missing.capabilities['ED-01'].state).toBe('unavailable')
    expect(missing.capabilities['RV-01'].state).toBe('unavailable')
  })
})
