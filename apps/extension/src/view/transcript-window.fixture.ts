import { TranscriptWindowService } from './transcript-window.js'
import { TranscriptWindowRegistry } from './transcript-window-registry.js'

/** A real projector for isolated gateway tests that never read an older page. */
export function transcriptWindowFixture(): TranscriptWindowRegistry {
  return new TranscriptWindowRegistry(
    () =>
      new TranscriptWindowService({
        read: () => Promise.resolve({ events: [], hasMore: false }),
        publicValue: (value) => value,
        post: () => Promise.resolve(true),
      }),
  )
}
