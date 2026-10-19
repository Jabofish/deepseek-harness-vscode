import path from 'node:path'

import type { WorkspaceSummary } from '@dsh-vscode/domain'
import { isCanonicalWorkspaceRelativePath } from '@dsh-vscode/domain'

import { isPathWithin } from '../backend/path-safety.js'
import { publicEditorCompanionTool } from './editor-companion-public.js'

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

/**
 * Convert a DSH present-tool source path into a renderer-safe workspace path.
 * The source may be absolute or relative to the viewed Session cwd, but only
 * a canonical path inside one of the currently owned workspace roots crosses
 * the Host/Webview boundary.
 */
export function publicWorkspaceRelativePath(
  sourcePath: string,
  sessionCwd: string | undefined,
  roots: readonly string[],
): string | undefined {
  const source = sourcePath.trim()
  if (source === '' || roots.length === 0) return undefined
  const base = sessionCwd ?? (roots.length === 1 ? roots[0] : undefined)
  const absolute = isAbsoluteHostPath(source)
    ? path.resolve(source)
    : base === undefined
      ? undefined
      : path.resolve(base, source)
  if (absolute === undefined) return undefined
  for (const root of roots) {
    if (!isPathWithin(root, absolute)) continue
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    return isCanonicalWorkspaceRelativePath(relative) ? relative : undefined
  }
  return undefined
}

/** Remove fields that are never needed by the renderer from public payloads. */
export function sanitizePublicValue(
  value: unknown,
  parentKey?: string,
  roots: readonly string[] = [],
  sessionCwd?: string,
): unknown {
  if (Array.isArray(value))
    return value.flatMap((entry: unknown) => {
      if (
        parentKey === 'paths' &&
        typeof entry === 'string' &&
        (isAbsoluteHostPath(entry) || sessionCwd !== undefined)
      ) {
        const relative = publicWorkspaceRelativePath(entry, sessionCwd, roots)
        return relative === undefined ? [] : [relative]
      }
      if (
        typeof entry === 'object' &&
        entry !== null &&
        'path' in entry &&
        typeof entry.path === 'string' &&
        isAbsoluteHostPath(entry.path) &&
        publicWorkspaceRelativePath(entry.path, undefined, roots) === undefined
      )
        return []
      return [sanitizePublicValue(entry, parentKey, roots, sessionCwd)]
    })
  if (typeof value !== 'object' || value === null) return value
  const source = value as Record<string, unknown>
  const editorTool = publicEditorCompanionTool(source)
  if (editorTool !== undefined) return editorTool
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (isSensitivePublicField(parentKey, key, entry, source)) continue
    if (source.type === 'session.projection' && source.key === 'workingDirectory' && key === 'value') {
      result[key] = null
      continue
    }
    if (
      (key === 'path' || key === 'filePath') &&
      typeof entry === 'string' &&
      (isAbsoluteHostPath(entry) || sessionCwd !== undefined)
    ) {
      const relative = publicWorkspaceRelativePath(entry, sessionCwd, roots)
      if (relative !== undefined) result[key] = relative
      continue
    }
    result[key] = sanitizePublicValue(entry, key, roots, sessionCwd)
  }
  return result
}

function isSensitivePublicField(
  parentKey: string | undefined,
  key: string,
  value: unknown,
  parent: Record<string, unknown>,
): boolean {
  const normalizedParent = parentKey?.toLocaleLowerCase()
  const normalizedKey = key.toLocaleLowerCase()

  // Provider catalog rows use `secret: boolean` as field metadata. Preserve
  // that structural flag while continuing to redact secret-bearing values.
  if (normalizedKey === 'secret' && typeof value === 'boolean') return false

  // The `commandLine` deny-list entry exists for process-discovery data, which
  // is Host-only. An approval request uses the same field name for the command
  // the user is about to authorize, which the approval card must render or the
  // decision is blind.
  if (normalizedKey === 'commandline' && isPermissionRequest(parent)) return false

  // These counters are intentionally public UI telemetry. The previous broad
  // `/token|input|output/` filter silently removed the DSH token meter and
  // tool summaries before they reached the Webview.
  if (normalizedParent === 'usage' || normalizedParent === 'tokenusage')
    return !SAFE_USAGE_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)
  if (normalizedParent === 'contextpressure')
    return !SAFE_CONTEXT_FIELDS.has(normalizedKey) && isExactSensitiveField(normalizedKey)

  return isExactSensitiveField(normalizedKey)
}

/** Structural match for the only approval request shape the product renders. */
function isPermissionRequest(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.options) && typeof value.sessionId === 'string' && typeof value.title === 'string'
  )
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
  'workingdirectory',
  'installtarget',
  'home',
])

function isAbsoluteHostPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')
}
