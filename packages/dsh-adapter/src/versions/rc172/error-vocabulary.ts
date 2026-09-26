import type { AlphaErrorCodeNormalizer } from '../alpha/transport.js'
import { normalizeAlpha171ErrorCode } from '../alpha171/error-vocabulary.js'

/** RC2 added business failures for the post-login default-model initializer. */
// The credentials code means the Host omitted settings/credential services;
// the models code means the account provider has no catalog entry. Neither
// establishes that the user must authenticate or supplied invalid settings.
const RC172_TO_LOCAL_RPC_CODE: Readonly<Record<string, string>> = {
  'session/provider-credentials-unavailable': 'host-provider-services-unavailable',
  'session/provider-models-unavailable': 'account-provider-models-unavailable',
}

export const normalizeRc172ErrorCode: AlphaErrorCodeNormalizer = (code, details) =>
  normalizeAlpha171ErrorCode(RC172_TO_LOCAL_RPC_CODE[code] ?? code, details)
