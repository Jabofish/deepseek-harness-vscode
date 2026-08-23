import { describe, expect, it } from 'vitest'

import { attachmentMimeType, prepareAttachment } from './attachment-codec.js'

describe('Extension Host attachment codec', () => {
  it('derives text MIME types and rejects binary bytes', () => {
    expect(attachmentMimeType('README.md', Buffer.from('# dsh'))).toBe('text/markdown')
    expect(attachmentMimeType('payload.bin', Buffer.from('# dsh'))).toBeUndefined()
    expect(attachmentMimeType('notes.txt', Buffer.from([0, 1]))).toBeUndefined()
  })

  it('prepares image data with a verified magic signature', () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    expect(prepareAttachment('image.png', bytes)).toMatchObject({
      name: 'image.png',
      mimeType: 'image/png',
      dataUri: 'data:image/png;base64,iVBORw0KGgo=',
    })
    expect(() => prepareAttachment('image.png', Buffer.from('not an image'))).toThrow(
      'contents do not match its declared image type',
    )
  })
})
