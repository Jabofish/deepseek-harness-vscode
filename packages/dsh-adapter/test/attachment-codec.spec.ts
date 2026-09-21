import { describe, expect, it } from 'vitest'
import { AppError } from '@dsh-vscode/domain'

import {
  decodeCanonicalBase64,
  encodeImageAttachments,
  encodePromptContent,
  isTextAttachment,
  matchesImageSignature,
  parseBase64DataUri,
  safeAttachmentName,
} from '../src/attachment-codec.js'

function errorFrom(run: () => unknown): AppError {
  try {
    run()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('expected the call to throw an AppError')
}

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

  it('blames the byte limit, not the encoding, when an attachment is too large', () => {
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8, 0xff)])
    const imageError = errorFrom(() =>
      encodePromptContent(
        'hi',
        [{ uri: `data:image/png;base64,${png.toString('base64')}`, name: 'shot.png' }],
        {
          maxImageBytes: 12,
          maxAttachmentTotalBytes: 64 * 1024 * 1024,
          maxImageTotalBytes: 64 * 1024 * 1024,
        },
      ),
    )
    expect(imageError.code).toBe('INVALID_CONFIGURATION')
    expect(imageError.message).toBe('The attachment is too large.')

    // Exactly at the limit must still be admitted: the size check is a strict `>`.
    const atLimit = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4, 0xff)])
    expect(
      encodePromptContent(
        'hi',
        [{ uri: `data:image/png;base64,${atLimit.toString('base64')}`, name: 'shot.png' }],
        {
          maxImageBytes: 12,
          maxAttachmentTotalBytes: 64 * 1024 * 1024,
          maxImageTotalBytes: 64 * 1024 * 1024,
        },
      ),
    ).toMatchObject([
      { type: 'text', text: 'hi' },
      { type: 'image', mediaType: 'image/png' },
    ])

    const oversizedText = Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)
    const textError = errorFrom(() =>
      encodePromptContent(
        'hi',
        [{ uri: `data:text/plain;base64,${oversizedText.toString('base64')}`, name: 'notes.txt' }],
        {
          maxImageBytes: 20 * 1024 * 1024,
          maxAttachmentTotalBytes: 64 * 1024 * 1024,
          maxImageTotalBytes: 64 * 1024 * 1024,
        },
      ),
    )
    expect(textError.code).toBe('INVALID_CONFIGURATION')
    expect(textError.message).toBe('The attachment is too large.')
  })
})

it('stages binary bytes only for an explicitly supported version and enforces the shared budget', () => {
  const attachments = [{ uri: 'data:application/octet-stream;base64,AAECAw==', name: 'archive.zip' }]
  const limits = { maxImageBytes: 8, maxAttachmentTotalBytes: 8, maxImageTotalBytes: 8 }
  expect(() => encodePromptContent('', attachments, limits)).toThrow('images and text-based files only')
  expect(encodePromptContent('', attachments, { ...limits, allowBinaryFiles: true })).toEqual([
    { type: 'text', text: '' },
    { type: 'file-upload', data: 'AAECAw==', name: 'archive.zip' },
  ])
  expect(() =>
    encodePromptContent('', attachments, { ...limits, allowBinaryFiles: true, maxAttachmentTotalBytes: 3 }),
  ).toThrow('combined attachment size')
})
