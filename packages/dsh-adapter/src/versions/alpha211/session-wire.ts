import {
  assertReleasedV4Header,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from 'dsh-session-format-alpha211'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'

/** Exact 5badb15009ae1756c3afe0ae0cef1faafc290ccc catalog v0/v1. */
export const alpha211SessionProfile: AlphaV4SessionProfile = {
  validateHeader: (header) => assertReleasedV4Header(header),
  validateEvent: (event) => {
    releasedV4SessionFormatCodec.encodeEvent(
      event as Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0],
    )
  },
  restoreArtifact: (artifact, known) => {
    restoreReleasedV4Artifact(artifact as Parameters<typeof restoreReleasedV4Artifact>[0], known)
  },
  eventValidators: { 'subagent/catalog': (value) => validCatalogFact(value) },
  normalizeEvent(event) {
    const data = recordOrUndefined(event.data)
    if (event.type === 'subagent/catalog' && data?.version === 1 && data.mode === 'unknown')
      return { ...event, unknownCatalogContract: true }
    return event.type === 'subagent/catalog' && data?.version === 1 && data.mode !== 'unknown'
      ? { ...event, data: { ...data, version: 0 } }
      : event
  },
}

export function validCatalogFact(value: unknown, external = false): boolean {
  const data = recordOrUndefined(value)
  if (
    data === undefined ||
    Object.keys(data).some((key) => !['version', 'childId', 'childCreatedAt', 'mode', 'label'].includes(key))
  )
    return false
  return (
    typeof data.childId === 'string' &&
    data.childId.trim() !== '' &&
    typeof data.childCreatedAt === 'number' &&
    Number.isSafeInteger(data.childCreatedAt) &&
    data.childCreatedAt >= 0 &&
    (data.label === undefined || typeof data.label === 'string') &&
    (((data.version === 0 || data.version === 1) &&
      (data.mode === 'one-shot' || (data.mode === 'continuable' && typeof data.label === 'string'))) ||
      (data.version === 1 && data.mode === 'unknown') ||
      (external && data.version === 2 && data.mode === 'external'))
  )
}
