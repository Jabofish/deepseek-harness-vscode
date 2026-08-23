import { describe, expect, it } from 'vitest'

import {
  decodeCanonicalBase64,
  encodeImageAttachments,
  isTextAttachment,
  matchesImageSignature,
  parseBase64DataUri,
  safeAttachmentName,
} from '../src/attachment-codec.js'

describe('attachment codec', () => {
  it('keeps data URI parsing and canonical decoding strict', () => {
    expect(parseBase64DataUri('data:text/plain;base64,SGk=')).toEqual({
      mediaType: 'text/plain',
      encoded: 'SGk=',
    })
    expect(decodeCanonicalBase64('SGk=')?.toString('utf8')).toBe('Hi')
    expect(decodeCanonicalBase64('SGk')).toBeUndefined()
    expect(decodeCanonicalBase64('SGk=\n')).toBeUndefined()
  })

  it('shares image, text, filename, and command image encoding rules', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    expect(matchesImageSignature('image/png', png)).toBe(true)
    expect(isTextAttachment('text/plain', 'notes.txt', Buffer.from('hello'))).toBe(true)
    expect(isTextAttachment('application/octet-stream', 'payload.bin', Buffer.from('hello'))).toBe(false)
    expect(safeAttachmentName('C:\\temp\\notes.txt')).toBe('notes.txt')
    expect(
      encodeImageAttachments([
        { uri: 'data:image/png;base64,SGk=', name: 'image.png', mimeType: 'image/png' },
      ]),
    ).toEqual([{ mediaType: 'image/png', data: 'SGk=', name: 'image.png' }])
    expect(
      encodeImageAttachments([{ uri: 'data:text/plain;base64,SGk=', name: 'notes.txt' }]),
    ).toBeUndefined()
  })
})
