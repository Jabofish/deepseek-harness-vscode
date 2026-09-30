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

  it('does not carry a filesystem path out of a transport diagnostic', () => {
    // Transport failures quote the socket or file the OS refused, so the raw
    // message names the user's home directory and drive layout. The Webview
    // must not receive an absolute path, and this scrubber is the shared gate
    // both the Adapter and the Extension Host rely on, so it has to drop the
    // path as well as the credentials.
    expect(redactText(String.raw`connect EACCES D:\Users\Ada\.dsh\run\agent.sock`, 240)).not.toContain(
      'Users',
    )
    expect(redactText('connect ENOENT /home/ada/.dsh/run/agent.sock', 240)).not.toContain('ada')
    // A Windows drive prefix and a POSIX root are both absolute.
    expect(redactText(String.raw`failed to open C:\Users\Ada\project\secret.txt`, 240)).not.toMatch(
      /[A-Za-z]:\\/u,
    )
    expect(redactText('failed to open /Users/ada/project/secret.txt', 240)).not.toMatch(/\/(?:Users|home)\//u)
  })

  it('keeps a relative identifier a card is allowed to show', () => {
    // Relative identifiers are the documented Webview contract, so the path
    // scrub must not eat them.
    const value = redactText('src/bundle.js is too large', 240)
    expect(value).toBe('src/bundle.js is too large')
  })
})
