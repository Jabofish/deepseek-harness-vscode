import { AppError } from '@dsh-vscode/domain'
import { restoreReleasedV4Artifact } from '@dsh-vscode/dsh-session-codec-alpha222'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { masterCatalogFactSchema, masterSequence, parseMasterContract } from './contracts.js'

/** fcc0ad session-format-v3-to-v4/src/validation.ts: nativeCatalogFact and own-suffix names. */
export function restoreMasterFcc0adArtifact(artifact: unknown, known: ReadonlySet<string>): void {
  const source = recordOrUndefined(artifact)
  if (source === undefined || !Array.isArray(source.events)) throw malformedArtifact()
  const inheritedCount = parseMasterContract(
    masterSequence,
    source.inheritedEventCount,
    'Session V4 artifact',
  )
  const names = new Set<unknown>()
  const events = source.events.map((raw: unknown) => {
    const event = recordOrUndefined(raw)
    if (
      event?.type !== 'subagent/catalog' ||
      !known.has(event.type) ||
      typeof event.seq !== 'number' ||
      event.seq < inheritedCount
    )
      return raw
    const data = recordOrUndefined(event.data)
    if (data === undefined) return raw
    if (data.version === 3) parseMasterContract(masterCatalogFactSchema, data, 'subagent/catalog')
    if (data.name !== undefined) {
      if (names.has(data.name)) throw malformedArtifact()
      names.add(data.name)
    }
    if (data.version !== 3) return raw
    // Validate new ownership rules first, then reuse the released validator for
    // lifecycle, delivery, dense sequences and duplicate child identities.
    // The projection is detached, and caller-owned events retain their fields.
    const { name, ...legacyFact } = data
    void name
    return { ...event, data: { ...legacyFact, version: data.mode === 'external' ? 2 : 0 } }
  })
  // The released validator owns the header and event checks at this raw JSON boundary.
  const projectedArtifact: unknown = { ...source, events }
  restoreReleasedV4Artifact(projectedArtifact as Parameters<typeof restoreReleasedV4Artifact>[0], known)
}

function malformedArtifact(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned conflicting or malformed native Session catalog history.',
    retryable: false,
  })
}
