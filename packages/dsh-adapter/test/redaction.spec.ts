import { describe, expect, it } from 'vitest'

import { redactText, safePayload } from '../src/redaction.js'

describe('shared redaction', () => {
  it('takes the union of sensitive text and URL credential rules', () => {
    const value = redactText(
      'https://alice:secret@example.invalid failed prompt=private body=payload response=result token=abc',
      512,
    )

    expect(value).toContain('https://[redacted]@example.invalid')
    expect(value).not.toContain('secret')
    expect(value).not.toContain('private')
    expect(value).not.toContain('payload')
    expect(value).not.toContain('result')
    expect(value).not.toContain('abc')
  })

  it('removes the union of sensitive payload fields and bounds nested data', () => {
    const value = safePayload({
      endpoint: 'http://127.0.0.1:3939',
      path: 'C:\\private',
      visible: { nested: { deeper: { deepest: { value: 'kept?' } } } },
      output: 'secret output',
    }) as Record<string, unknown>

    expect(value).not.toHaveProperty('endpoint')
    expect(value).not.toHaveProperty('path')
    expect(value).not.toHaveProperty('output')
    expect(value.visible).toEqual({ nested: { deeper: { deepest: '[truncated]' } } })
  })
})
