import type { AlphaErrorCodeNormalizer } from '../alpha/transport.js'
import { normalizeRc172ErrorCode } from '../rc172/error-vocabulary.js'

/** Gateway rejects passive interactions and disposed peers before invoking business code. */
export const normalizeAlpha213ErrorCode: AlphaErrorCodeNormalizer = (code, details) =>
  normalizeRc172ErrorCode(
    code === 'gateway/interactions-forbidden'
      ? 'interactions-forbidden'
      : code === 'gateway/peer-disposed'
        ? 'peer-disposed'
        : code,
    details,
  )
