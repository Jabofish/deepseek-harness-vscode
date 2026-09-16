import { describe, expect, it } from 'vitest'

import { redactMultilineText, redactText, safePayload } from '../src/redaction.js'

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

  it('keeps the line structure of diffs and code previews while redacting each line', () => {
    const diff = [
      '--- old',
      'const token = "abc"',
      '+  indented line',
      '-  removed line',
      '  unchanged',
      '+++ new',
    ].join('\n')
    const value = redactMultilineText(diff, 4_096)

    // A unified diff rendered inside a `<pre>` is unreadable once every run of
    // whitespace has been folded into a single space.
    expect(value.split('\n')).toHaveLength(6)
    expect(value).toContain('+  indented line')
    expect(value).toContain('\n  unchanged')
    expect(value).not.toContain('abc')
    expect(value).toContain('token : [redacted]')
  })

  it('normalizes CRLF and bounds multi-line text without joining lines', () => {
    expect(redactMultilineText('one\r\ntwo\r\nthree', 4_096)).toBe('one\ntwo\nthree')
    expect(redactMultilineText('one\ntwo\nthree', 7)).toBe('one\ntwo')
  })
})
