import path from 'node:path'
import {
  assertReleasedV4Header,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from 'dsh-session-format-alpha212'

import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { validCatalogFact } from '../alpha211/session-wire.js'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'

/** dsh-v0.2.1-alpha.2 / d743267388641bc76f17c45ce8b4c231aed1d32c.
 * working-directory/src/index.ts and subagent/src/catalog.ts: required V4 facts.
 * Operation paths stay Host-private until workspace ownership projection.
 */
export const alpha212SessionProfile: AlphaV4SessionProfile = {
  validateHeader: (header) => assertReleasedV4Header(header),
  validateEvent: (event) => {
    releasedV4SessionFormatCodec.encodeEvent(
      event as Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0],
    )
  },
  restoreArtifact: (artifact, known) => {
    restoreReleasedV4Artifact(artifact as Parameters<typeof restoreReleasedV4Artifact>[0], known)
  },
  eventValidators: {
    'working-directory/change': (value) => {
      const data = recordOrUndefined(value)
      return data !== undefined && Object.keys(data).length === 1 && absolutePath(data.cwd)
    },
    'subagent/catalog': (value) => validCatalogFact(value, true),
  },
  normalizeEvent(event) {
    const data = recordOrUndefined(event.data)
    if (event.type === 'working-directory/change')
      return {
        ...event,
        type: 'session/projection',
        data: { key: 'workingDirectory', value: data?.cwd, seq: event.seq },
      }
    if (event.type === 'subagent/catalog' && data?.version === 1 && data.mode !== 'unknown')
      return { ...event, data: { ...data, version: 0 } }
    if (event.type === 'subagent/catalog' && data?.version === 1 && data.mode === 'unknown')
      return { ...event, unknownCatalogContract: true }
    if (event.type === 'subagent/catalog' && data?.version === 2)
      return { ...event, externalCatalogContract: true }
    if ((event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') && data !== undefined) {
      const meta = recordOrUndefined(data.meta)
      // Only successful structured results supply navigation authority.
      const message = recordOrUndefined(data.message)
      const failedBlock =
        Array.isArray(message?.content) &&
        message.content.some((entry: unknown) => {
          const block = recordOrUndefined(entry)
          return block?.type === 'tool-result' && block.isError === true
        })
      if (data.error !== undefined || message?.isError === true || data.isError === true || failedBlock)
        return event
      if (absolutePath(meta?.path)) return { ...event, data: { ...data, locations: [{ path: meta.path }] } }
    }
    return event
  },
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 32_768 &&
    !value.includes('\0') &&
    (path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
  )
}
