import type { AlphaErrorCodeNormalizer } from '../alpha/transport.js'
import { normalizeRc172ErrorCode } from '../rc172/error-vocabulary.js'

/** Error codes added by the exact 0.2.0-rc.2 userQuestions Remote. */
const RC202_TO_LOCAL_RPC_CODE: Readonly<Record<string, string>> = {
  BAD_ANSWER: 'bad-request',
  REPLY_QUEUED: 'writer-held',
  CALLER_NOT_LIVE: 'subagent-unauthorized',
  DELEGATED_CALLER: 'subagent-unauthorized',
}

export const normalizeRc202ErrorCode: AlphaErrorCodeNormalizer = (code, details) =>
  normalizeRc172ErrorCode(RC202_TO_LOCAL_RPC_CODE[code] ?? code, details)
