import { describe, expect, it } from 'vitest'

import { deriveFeatureCapabilityProfile } from '../src/feature-capabilities.js'
import { SUPPORTED_DSH_VERSIONS } from '../src/contracts.js'

const base = {
  protocolVersion: 'rc12',
  features: new Set(['host', 'workspace', 'session', 'events']),
}

describe('staged feature capability profile', () => {
  it('marks pinned upstream contract coverage separately from incomplete surfaces', () => {
    const profile = deriveFeatureCapabilityProfile({
      ...base,
      dshVersion: '0.1.1-rc.2',
    })
    expect(profile.source).toBe('pinned-adapter')
    expect(profile.capabilities['ED-01'].state).toBe('verified-contract')
    expect(profile.capabilities['ED-01'].upstream).toBe('verified-contract')
    expect(profile.capabilities['RV-01'].state).toBe('verified-contract')
    expect(profile.capabilities['RV-01'].upstream).toBe('verified-contract')
    expect(profile.capabilities['TC-01'].state).toBe('compatibility-fallback')
    expect(profile.capabilities['CP-01'].state).toBe('verified-contract')
    expect(profile.capabilities['SY-01'].state).toBe('verified-contract')
    expect(profile.capabilities['SY-01'].upstream).toBe('verified-contract')
    expect(profile.capabilities['RF-01'].state).toBe('verified-contract')
    expect(profile.capabilities['RF-01'].upstream).toBe('verified-contract')
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

  it('does not become pinned when a best-effort adapter reports a known wire version', () => {
    const profile = deriveFeatureCapabilityProfile({
      ...base,
      dshVersion: '0.1.2-alpha.3',
      compatibilityMode: 'best-effort',
    })

    expect(profile.source).toBe('compatibility-fallback')
    expect(profile.capabilities['ED-01'].state).toBe('compatibility-fallback')
  })

  it('keeps every pinned release and alpha adapter on the same profile contract', () => {
    for (const dshVersion of SUPPORTED_DSH_VERSIONS) {
      const profile = deriveFeatureCapabilityProfile({
        ...base,
        dshVersion,
      })
      expect(profile.dshVersion).toBe(dshVersion)
      expect(profile.source).toBe('pinned-adapter')
      expect(profile.capabilities['ED-01'].state).toBe('verified-contract')
      expect(profile.capabilities['ED-01'].upstream).toBe('verified-contract')
      expect(profile.capabilities['RV-01'].state).toBe('verified-contract')
      expect(profile.capabilities['SY-01'].state).toBe('verified-contract')
    }
  })
})
