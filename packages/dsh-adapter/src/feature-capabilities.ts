import {
  FEATURE_CAPABILITY_IDS,
  type BackendCapabilities,
  type FeatureCapability,
  type FeatureCapabilityId,
  type FeatureCapabilityProfile,
} from '@dsh-vscode/domain'

import { isKnownDshVersion } from './contracts.js'

type CapabilityInput = Pick<
  BackendCapabilities,
  'dshVersion' | 'protocolVersion' | 'features' | 'compatibilityMode' | 'compatibilityWarning'
>

/**
 * Derive the staged feature readiness profile without inferring support from
 * a method name or from a UI response. Unknown runtimes may use the newest
 * verified adapter implementation in best-effort mode, but every new surface
 * is explicitly downgraded until its own contract is verified.
 */
export function deriveFeatureCapabilityProfile(input: CapabilityInput): FeatureCapabilityProfile {
  const pinned =
    input.compatibilityMode !== 'best-effort' &&
    input.compatibilityWarning === undefined &&
    isKnownDshVersion(input.dshVersion)
  const source: FeatureCapabilityProfile['source'] = pinned ? 'pinned-adapter' : 'compatibility-fallback'

  const upstream = (
    requiredFeatures: readonly string[],
    label: string,
    routeState: 'verified-contract' | 'unavailable' = 'unavailable',
  ): FeatureCapability => {
    const missing = requiredFeatures.filter((feature) => !input.features.has(feature))
    if (missing.length > 0) {
      return {
        state: 'unavailable',
        upstream: 'unavailable',
        reason: `${label} requires unavailable DSH features: ${missing.join(', ')}.`,
      }
    }
    if (!pinned) {
      return {
        state: 'compatibility-fallback',
        upstream: 'compatibility-fallback',
        reason: `${label} is not enabled for an unknown or compatibility-fallback DSH runtime.`,
      }
    }
    return {
      state: routeState,
      upstream: 'verified-contract',
      ...(routeState === 'unavailable'
        ? { reason: `${label} upstream prerequisites are pinned; the extension route is not enabled.` }
        : {}),
    }
  }

  const sessionScopedTaskSource: FeatureCapability = input.features.has('session')
    ? {
        state: 'compatibility-fallback',
        upstream: pinned ? 'verified-contract' : 'compatibility-fallback',
        reason:
          'The pinned DSH task source is session-scoped; workspace composition is available but global task seed/replay/ownership is not verified.',
      }
    : {
        state: 'unavailable',
        upstream: 'unavailable',
        reason: 'TC-01 requires the DSH session capability.',
      }

  const capabilities: Record<FeatureCapabilityId, FeatureCapability> = {
    'ED-01': upstream(['workspace', 'session'], 'ED-01 editor context', 'verified-contract'),
    'RV-01': upstream(['session', 'events'], 'RV-01 change review', 'verified-contract'),
    'TC-01': sessionScopedTaskSource,
    // CP-01 is an extension-owned local capability. It does not claim a new
    // DSH RPC; content persistence remains opt-in in the extension settings.
    'CP-01': {
      state: 'verified-contract',
      upstream: 'not-applicable',
      reason: 'Local checkpoint metadata is available; content restore requires explicit extension settings.',
    },
    // PT-01 is extension-owned local state; it does not claim a new DSH RPC.
    'PT-01': {
      state: 'verified-contract',
      upstream: 'not-applicable',
      reason:
        'Local prompt template lifecycle is available; mode mapping remains bounded by DSH capabilities and approvals.',
    },
    'NAV-01': upstream(['host', 'workspace'], 'NAV-01 navigation', 'verified-contract'),
    // SY-01 is an extension-owned Language Service route. The active editor
    // availability remains host-projected; this entry only records that the
    // route is implemented and does not claim a new DSH RPC.
    'SY-01': {
      state: 'verified-contract',
      upstream: 'not-applicable',
      reason:
        'VS Code symbol and diagnostic context capture is available when the active document reports it.',
    },
    'RF-01': {
      state: 'verified-contract',
      upstream: 'not-applicable',
      reason: 'Extension-owned redacted diagnostics and reconnect recovery are available.',
    },
  }

  // Keep this assertion close to the construction so adding an ID cannot
  // silently omit it from the profile object.
  for (const id of FEATURE_CAPABILITY_IDS) {
    if (!(id in capabilities)) throw new Error(`Missing feature capability profile entry: ${id}`)
  }

  return {
    dshVersion: input.dshVersion,
    protocolVersion: input.protocolVersion,
    source,
    capabilities,
  }
}
