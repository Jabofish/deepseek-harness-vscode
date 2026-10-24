/* global module */
'use strict'

/** Only inspect known error fields; classification must not print credentials. */
function getErrorText(error, depth = 0) {
  if (depth > 3 || error == null) return ''
  if (typeof error === 'string' || typeof error === 'number') return String(error).slice(0, 16_384)
  if (typeof error !== 'object') return ''
  return ['name', 'message', 'statusCode', 'code', 'result', 'body', 'response', 'cause']
    .map((key) => getErrorText(error[key], depth + 1))
    .join('\n')
}

function isRetryableMarketplaceError(error) {
  return /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|\b(?:429|502|503|504)\b|bad gateway|gateway timeout|service(?:s)? (?:isn't|are not|unavailable)|RequestBlockedException|exceeding usage of resource|rate.?limit/iu.test(
    getErrorText(error),
  )
}

function marketplaceRetryDelay(error, attempt, now = Date.now()) {
  const headers = error?.response?.headers ?? error?.headers
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (typeof retryAfter === 'string' || typeof retryAfter === 'number') {
    const seconds = Number(retryAfter)
    const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(String(retryAfter)) - now
    // Do not retry sooner than the service requests; oversized waits fail for a later release attempt.
    if (Number.isFinite(milliseconds) && milliseconds > 300_000) return undefined
    if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.ceil(milliseconds)
  }
  return Math.min(30_000 * 2 ** (attempt - 1), 120_000)
}

module.exports = { isRetryableMarketplaceError, marketplaceRetryDelay }
