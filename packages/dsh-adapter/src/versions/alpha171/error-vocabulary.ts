import type { AlphaErrorCodeNormalizer } from '../alpha/transport.js'
import { normalizeAlpha2ErrorCode } from '../alpha2/error-vocabulary.js'

/**
 * Alpha.1 adds business failures for the new Workspace archive admission and
 * Job Controller. Keep their mapping at this version seam: older alpha
 * adapters must continue to fail closed for codes they never declared.
 */
const ALPHA171_TO_LEGACY_RPC_CODE: Readonly<Record<string, string>> = {
  'workspace/session-active': 'workspace-session-active',
  'job/not-found': 'job-not-found',
}

export const normalizeAlpha171ErrorCode: AlphaErrorCodeNormalizer = (code, details) =>
  normalizeAlpha2ErrorCode(ALPHA171_TO_LEGACY_RPC_CODE[code] ?? code, details)
