import { describe, expect, it, vi } from 'vitest'

import {
  assertAttachmentSupported,
  isAttachmentSupported,
  attachmentMimeType,
  prepareAttachment,
  readAttachmentFile,
} from './attachment-codec.js'

describe('Extension Host attachment codec', () => {
  it('derives text MIME types, stages binary files and rejects corrupt declared text', () => {
    expect(attachmentMimeType('README.md', Buffer.from('# dsh'))).toBe('text/markdown')
    expect(attachmentMimeType('payload.bin', Buffer.from('# dsh'))).toBe('application/octet-stream')
    expect(attachmentMimeType('notes.txt', Buffer.from([0, 1]))).toBeUndefined()
  })

  it('rejects an oversized file from its stat before reading any bytes', async () => {
    const readFile = vi.fn(() => Promise.resolve(Buffer.from('# dsh')))
    const fileSystem = {
      stat: () => Promise.resolve({ isFile: () => true, size: 9 * 1024 * 1024 }),
      readFile,
    }

    await expect(readAttachmentFile('huge.log', 'huge.log', fileSystem)).rejects.toThrow(
      'too large to attach',
    )
    expect(readFile).not.toHaveBeenCalled()
    // An image gets the larger image budget, so the same size still reads.
    await expect(
      readAttachmentFile('photo.png', 'photo.png', {
        stat: () => Promise.resolve({ isFile: () => true, size: 9 * 1024 * 1024 }),
        readFile: () => Promise.resolve(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      }),
    ).resolves.toMatchObject({ name: 'photo.png', mimeType: 'image/png' })
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

it.each([false, true])(
  'checks normalized binary attachments before staging (uploads=%s)',
  (supportsUploads) => {
    const input = prepareAttachment('report.pdf', Buffer.from([0, 1, 2]))
    expect(isAttachmentSupported(input.mimeType, supportsUploads)).toBe(supportsUploads)
    if (supportsUploads) expect(() => assertAttachmentSupported(input, supportsUploads)).not.toThrow()
    else expect(() => assertAttachmentSupported(input, supportsUploads)).toThrow('only image and text')
    expect(isAttachmentSupported('text/plain', supportsUploads)).toBe(true)
    expect(isAttachmentSupported('image/png', supportsUploads)).toBe(true)
    expect(isAttachmentSupported(undefined, supportsUploads)).toBe(false)
  },
)
