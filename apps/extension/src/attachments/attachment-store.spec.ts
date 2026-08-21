import { describe, expect, it } from 'vitest'
import {
  AttachmentStore,
  decodeCanonicalBase64,
  MAX_ATTACHMENT_COUNT,
  validImageBytes,
} from './attachment-store.js'

describe('attachment ingest boundary', () => {
  it('accepts canonical Base64 and rejects decoder-tolerated malformed forms', () => {
    expect(decodeCanonicalBase64('aGk=')).toEqual(Buffer.from('hi'))
    for (const malformed of ['aGk', 'aGk==', 'a===', 'aG k=', '===='])
      expect(() => decodeCanonicalBase64(malformed)).toThrow(/could not be decoded/i)
  })

  it('enforces the decoded byte limit instead of trusting encoded length', () => {
    expect(() => decodeCanonicalBase64(Buffer.alloc(5).toString('base64'), 4)).toThrow(
      /could not be decoded/i,
    )
  })

  it('rejects image-extension spoofing by checking each supported magic header', () => {
    expect(validImageBytes('image/png', Buffer.from('not a png'))).toBe(false)
    expect(validImageBytes('image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
    expect(validImageBytes('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
    expect(validImageBytes('image/gif', Buffer.from('GIF89a'))).toBe(true)
    expect(validImageBytes('image/webp', Buffer.from('RIFF0000WEBP'))).toBe(true)
  })
})

describe('AttachmentStore', () => {
  it('returns only opaque handles and resolves stored, not Webview-supplied, metadata', () => {
    const store = new AttachmentStore(
      () => 0,
      () => '00000000-0000-4000-8000-000000000001',
    )
    const handle = store.remember({
      name: 'actual.txt',
      mimeType: 'text/plain',
      dataUri: 'data:text/plain;base64,aGk=',
    })

    expect(handle.uri).toMatch(/^dsh-attachment:/)
    expect(handle.uri).not.toContain('aGk=')
    expect(store.resolve([{ ...handle, name: 'forged.exe', mimeType: 'application/octet-stream' }])).toEqual([
      {
        uri: 'data:text/plain;base64,aGk=',
        name: 'actual.txt',
        mimeType: 'text/plain',
      },
    ])
  })

  it('limits previews to live images and releases handles after consumption', () => {
    const tokens = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
    const store = new AttachmentStore(
      () => 0,
      () => tokens.shift()!,
    )
    const image = store.remember({
      name: 'image.png',
      mimeType: 'image/png',
      dataUri: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const text = store.remember({
      name: 'notes.txt',
      mimeType: 'text/plain',
      dataUri: 'data:text/plain;base64,aGk=',
    })

    expect(store.preview(image.uri)).toContain('data:image/png')
    expect(store.preview(text.uri)).toBeUndefined()
    store.release([image, text])
    expect(store.size).toBe(0)
    expect(() => store.resolve([image])).toThrow(/no longer available/i)
  })

  it('expires handles and refuses to invalidate a live handle at the bounded capacity', () => {
    let now = 0
    let next = 0
    const store = new AttachmentStore(
      () => now,
      () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`,
    )
    const handles = Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) =>
      store.remember({ name: `${index}.txt`, dataUri: 'data:text/plain;base64,eA==' }),
    )
    expect(store.size).toBe(MAX_ATTACHMENT_COUNT)
    expect(() => store.remember({ name: 'overflow.txt', dataUri: 'data:text/plain;base64,eA==' })).toThrow(
      new RegExp(`at most ${MAX_ATTACHMENT_COUNT} attachment drafts`, 'i'),
    )
    expect(store.resolve([handles[0]!])).toHaveLength(1)

    store.releaseUris([handles[0]!.uri])
    expect(() =>
      store.remember({ name: 'replacement.txt', dataUri: 'data:text/plain;base64,eA==' }),
    ).not.toThrow()

    now = 10 * 60 * 1000
    expect(store.size).toBe(0)
    expect(store.preview(handles[7]!.uri)).toBeUndefined()
  })
})
