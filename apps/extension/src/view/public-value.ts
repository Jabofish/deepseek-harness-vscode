import type { WorkspaceSummary } from '@dsh-vscode/domain'

/**
 * Project a workspace summary across the Host/Webview boundary.
 *
 * The Extension Host keeps the absolute path for membership checks, but the
 * renderer only needs the opaque workspace id and its display metadata.
 */
export function publicWorkspaceSummary(value: WorkspaceSummary): Omit<WorkspaceSummary, 'path'> {
  const { path, ...summary } = value
  void path
  return summary
}

/** Remove fields that are never needed by the renderer from public payloads. */
export function sanitizePublicValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizePublicValue(entry, parentKey))
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitivePublicField(parentKey, key, entry)) continue
    result[key] = sanitizePublicValue(entry, key)
  }
  return result
}

function isSensitivePublicField(parentKey: string | undefined, key: string, value: unknown): boolean {
  const normalizedParent = parentKey?.toLocaleLowerCase()
  const normalizedKey = key.toLocaleLowerCase()

  // Provider catalog rows use `secret: boolean` as field metadata. Preserve
  // that structural flag while continuing to redact secret-bearing values.
  if (normalizedKey === 'secret' && typeof value === 'boolean') return false

  // These counters are intentionally public UI telemetry. The previous broad
  // `/token|input|output/` filter silently removed the DSH token meter and
  // tool summaries before they reached the Webview.
  if (normalizedParent === 'usage' || normalizedParent === 'tokenusage')
    return !SAFE_USAGE_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)
  if (normalizedParent === 'contextpressure')
    return !SAFE_CONTEXT_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)

  return isExactSensitiveField(normalizedKey)
}

const SAFE_USAGE_FIELDS = new Set([
  'inputtokens',
  'uncachedinputtokens',
  'outputtokens',
  'cachereadtokens',
  'cachewritetokens',
  'reasoningtokens',
])

const SAFE_CONTEXT_FIELDS = new Set(['pressuretokens', 'projectedtokens', 'contextwindow'])

function isExactSensitiveField(key: string): boolean {
  return SENSITIVE_PUBLIC_FIELDS.has(key)
}

const SENSITIVE_PUBLIC_FIELDS = new Set([
  'endpoint',
  'baseurl',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'secretkey',
  'privatekey',
  'token',
  'pid',
  'processid',
  'process_id',
  'executable',
  'executablepath',
  'executable_path',
  'managedport',
  'managed_port',
  'attachports',
  'attach_ports',
  'serverurl',
  'server_url',
  'commandline',
  'stack',
  'body',
  'response',
  // Session cwd and host home are useful to the privileged Host only. In
  // particular, do not let a tool presentation reintroduce an absolute cwd.
  'cwd',
  'home',
])
