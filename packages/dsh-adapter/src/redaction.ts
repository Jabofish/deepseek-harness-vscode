/**
 * Version-neutral bounded redaction shared by transport diagnostics and
 * unknown-event projections. The field set intentionally takes the union of
 * the adapter and Extension Host deny lists so a newly forwarded payload does
 * not become a secret leak merely because it came through another path.
 */
const SENSITIVE_FIELDS = new Set([
  'key',
  'apikey',
  'api_key',
  'authorization',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'token',
  'secret',
  'secretkey',
  'privatekey',
  'password',
  'prompt',
  'body',
  'response',
  'input',
  'output',
  'command',
  'commandline',
  'endpoint',
  'baseurl',
  'path',
  'cwd',
  'directory',
  'executable',
  'pid',
  'stack',
  'processid',
  'process_id',
  'executablepath',
  'executable_path',
  'managedport',
  'managed_port',
  'attachports',
  'attach_ports',
  'serverurl',
  'server_url',
])

const SENSITIVE_TEXT_PATTERN =
  /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|secret|private[_ -]?key|token|prompt|body|response)\b\s*[:=]\s*[^\s,;]+/giu

const MAX_SAFE_PAYLOAD_DEPTH = 4
const MAX_SAFE_PAYLOAD_ITEMS = 32
const MAX_SAFE_PAYLOAD_KEYS = 64
const MAX_SAFE_PAYLOAD_STRING = 512

/** Redact credentials embedded in URLs and sensitive key/value text. */
export function redactText(value: string, maximumLength: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  if (compact === '') return ''
  return compact
    .replace(/(https?:\/\/)([^/\s:@]+(?::[^/\s@]*)?@)/giu, '$1[redacted]@')
    .replace(SENSITIVE_TEXT_PATTERN, (match) => match.replace(/[:=].*$/u, ': [redacted]'))
    .slice(0, maximumLength)
}

/** Remove sensitive fields and bound recursive unknown protocol payloads. */
export function safePayload(value: unknown, depth = 0): unknown {
  if (depth >= MAX_SAFE_PAYLOAD_DEPTH) return '[truncated]'
  if (typeof value === 'string') return redactText(value, MAX_SAFE_PAYLOAD_STRING)
  if (Array.isArray(value))
    return value.slice(0, MAX_SAFE_PAYLOAD_ITEMS).map((entry) => safePayload(entry, depth + 1))
  const object = record(value)
  if (object === undefined) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(object).slice(0, MAX_SAFE_PAYLOAD_KEYS)) {
    if (isSensitiveField(key)) continue
    result[key] = safePayload(entry, depth + 1)
  }
  return result
}

export function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELDS.has(key.toLocaleLowerCase())
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
