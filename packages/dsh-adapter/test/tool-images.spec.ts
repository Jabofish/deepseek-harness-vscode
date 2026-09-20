import { describe, expect, it } from 'vitest'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

const image = { attachmentId: 'opaque-image', mediaType: 'image/png', bytes: 80, width: 2, height: 1 }
const content = [
  { type: 'text', text: 'Image result' },
  { type: 'image', attachment: image },
]

describe('durable tool result images', () => {
  it('projects images nested in the result matching this call without losing text', () => {
    const event = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      data: {
        callId: 'c1',
        name: 'read_image',
        message: { content: [{ type: 'tool-result', toolCallId: 'c1', content }] },
      },
    })
    expect(event).toMatchObject({
      type: 'tool.updated',
      tool: { images: [image], outputSummary: 'Image result' },
    })
  })
  it('projects durable images from nested PTC dispatch results', () => {
    const event = rc6Mapper.event('tool/ptc-dispatch', {
      sessionId: 's1',
      data: {
        parentCallId: 'parent',
        subCallId: 'child',
        name: 'read_image',
        content,
        isError: false,
      },
    })
    expect(event).toMatchObject({
      type: 'tool.updated',
      tool: { id: 'child', parentCallId: 'parent', images: [image] },
    })
  })
  it('never turns call arguments, inline URLs or another call result into attachment references', () => {
    const event = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      data: {
        callId: 'c1',
        name: 'read_image',
        arguments: { image },
        message: {
          content: [
            { type: 'tool-result', toolCallId: 'other', content },
            { type: 'image', url: 'https://example.invalid/image.png' },
          ],
        },
      },
    })
    expect(event).not.toHaveProperty('tool.images')
  })
})
