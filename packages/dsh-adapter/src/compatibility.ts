import type { BackendCapabilities } from '@dsh-vscode/domain'

import { deriveFeatureCapabilityProfile } from './feature-capabilities.js'
import {
  LATEST_COMPATIBILITY_FALLBACK_DSH_VERSION,
  normalizeDshVersion,
  SUPPORTED_DSH_RANGE,
} from './contracts.js'

/** Attach the adapter identity without changing a pinned capability result. */
export function withExactAdapterCapabilities(
  capabilities: BackendCapabilities,
  adapterId: string,
): BackendCapabilities {
  return {
    ...capabilities,
    adapterId,
    compatibilityMode: 'exact',
  }
}

/**
 * Preserve the real runtime label while projecting a best-effort adapter
 * result. Re-derive the feature profile so unknown runtimes are never exposed
 * as pinned contract coverage.
 */
export function withBestEffortAdapterCapabilities(
  capabilities: BackendCapabilities,
  runtimeVersion: string | undefined,
  adapterId: string,
): BackendCapabilities {
  const normalizedVersion = normalizeDshVersion(runtimeVersion)
  const dshVersion = normalizedVersion ?? 'unknown'
  const decorated: BackendCapabilities = {
    ...capabilities,
    dshVersion,
    adapterId,
    compatibilityMode: 'best-effort',
    compatibilityWarning:
      normalizedVersion === undefined
        ? `The DSH runtime did not expose its package version; compatibility is being checked against the newest safe fallback adapter for ${LATEST_COMPATIBILITY_FALLBACK_DSH_VERSION} (${SUPPORTED_DSH_RANGE}).`
        : `DSH ${normalizedVersion} is outside the tested compatibility range (${SUPPORTED_DSH_RANGE}); the newest safe fallback adapter is ${LATEST_COMPATIBILITY_FALLBACK_DSH_VERSION}, and best-effort compatibility mode is active.`,
  }
  return {
    ...decorated,
    featureProfile: deriveFeatureCapabilityProfile(decorated),
  }
}
