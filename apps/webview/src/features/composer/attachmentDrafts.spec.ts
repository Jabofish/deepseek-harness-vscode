import { describe, expect, it } from 'vitest'
import { attachmentDraftKey, browserFileOrigin } from './attachmentDrafts.js'

describe('attachment draft identity', () => {
  it('distinguishes browser files with the same name when their metadata differs', () => {
    const first = new File(['one'], 'notes.txt', { type: 'text/plain', lastModified: 1 })
    const second = new File(['two'], 'notes.txt', { type: 'text/plain', lastModified: 2 })
    const attachment = { name: 'notes.txt', mimeType: 'text/plain' }

    expect(attachmentDraftKey(attachment, browserFileOrigin(first))).not.toBe(
      attachmentDraftKey(attachment, browserFileOrigin(second)),
    )
  })

  it('normalizes opaque picker metadata so the same file is not duplicated', () => {
    expect(attachmentDraftKey({ name: ' Notes.TXT ', mimeType: 'TEXT/PLAIN' })).toBe(
      attachmentDraftKey({ name: 'notes.txt', mimeType: 'text/plain' }),
    )
  })
})
