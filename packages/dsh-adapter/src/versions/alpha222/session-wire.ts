import {
  assertReleasedV4Header,
  releasedV4SessionFormatCodec,
  restoreReleasedV4Artifact,
} from '@dsh-vscode/dsh-session-codec-alpha222'
import { alpha213SessionProfile } from '../alpha213/session-wire.js'
import type { AlphaV4SessionProfile } from '../alpha171/session-wire.js'

/** The pinned V4 relationship validator fixes inherited delivery markers.
 * Durable event and projection vocabularies retain the preceding released shapes.
 */
export const alpha222SessionProfile: AlphaV4SessionProfile = {
  ...alpha213SessionProfile,
  validateHeader: (header) => assertReleasedV4Header(header),
  validateEvent: (event) => {
    releasedV4SessionFormatCodec.encodeEvent(
      event as Parameters<typeof releasedV4SessionFormatCodec.encodeEvent>[0],
    )
  },
  restoreArtifact: (artifact, known) => {
    restoreReleasedV4Artifact(artifact as Parameters<typeof restoreReleasedV4Artifact>[0], known)
  },
}
