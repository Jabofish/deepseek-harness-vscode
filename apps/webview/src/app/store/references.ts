import type { ReferenceCandidate } from './types.js'
import { object } from './unknown-record.js'

export function hasUnsafeReferencePath(value: string): boolean {
  if (value.includes('"')) return true
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

export function referenceCandidates(value: unknown): readonly ReferenceCandidate[] {
  const record = object(value)
  if (record === undefined) return []
  const candidates: ReferenceCandidate[] = []
  const seen = new Set<string>()
  if (Array.isArray(record.files))
    for (const value of record.files) {
      const item = object(value)
      if (
        item === undefined ||
        typeof item.path !== 'string' ||
        item.path.trim() === '' ||
        item.path.length > 4_096 ||
        hasUnsafeReferencePath(item.path) ||
        (item.kind !== 'file' && item.kind !== 'directory')
      )
        continue
      const id = `file:${item.path}`
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({
        id,
        kind: item.kind,
        path: item.path,
        label: referenceLabel(item.path),
        description: item.path,
      })
    }
  if (Array.isArray(record.sessions))
    for (const value of record.sessions) {
      const item = object(value)
      if (
        item === undefined ||
        typeof item.sessionId !== 'string' ||
        item.sessionId.trim() === '' ||
        typeof item.label !== 'string' ||
        item.label.trim() === '' ||
        typeof item.sameWorkspace !== 'boolean' ||
        typeof item.mention !== 'string' ||
        !/^@\[[^\]\r\n]{1,512}\]\(dsh-session:[A-Za-z0-9_-]{1,512}\)$/u.test(item.mention)
      )
        continue
      const id = `session:${item.sessionId}`
      if (seen.has(id)) continue
      seen.add(id)
      candidates.push({
        id,
        kind: 'session',
        sessionId: item.sessionId,
        label: item.label,
        description: typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : item.sessionId,
        mention: item.mention,
        sameWorkspace: item.sameWorkspace,
      })
    }
  return candidates.slice(0, 100)
}

export function referenceLabel(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  const slash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return slash >= 0 && slash + 1 < normalized.length ? normalized.slice(slash + 1) : normalized
}
