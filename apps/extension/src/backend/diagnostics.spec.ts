import { describe, expect, it } from 'vitest'
import { RedactedDiagnostics } from './diagnostics.js'

function fakeChannel(): {
  readonly lines: string[]
  readonly channel: ConstructorParameters<typeof RedactedDiagnostics>[0]
} {
  const lines: string[] = []
  return {
    lines,
    channel: {
      appendLine: (line: string): void => {
        lines.push(line)
      },
      show: (..._args: unknown[]): void => undefined,
      dispose: () => undefined,
    },
  }
}

describe('RedactedDiagnostics', () => {
  it('keeps allowlisted fields and redacts free-text fields', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    diagnostics.log('error', 'request-unexpected', {
      requestType: 'session.open',
      name: 'TypeError',
      message: 'cannot read token=super-secret of undefined',
      stack: 'at f (file.ts:1:1)\npassword=hunter2',
      pid: 4242,
      endpoint: 'http://127.0.0.1:3939',
    })

    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '') as { fields: Record<string, string> }
    expect(entry.fields.requestType).toBe('session.open')
    expect(entry.fields.name).toBe('TypeError')
    expect(entry.fields.message).not.toContain('super-secret')
    expect(entry.fields.message).toContain('token: [redacted]')
    expect(entry.fields.stack).toContain('[redacted]')
    expect(entry.fields).not.toHaveProperty('pid')
    expect(entry.fields).not.toHaveProperty('endpoint')
    diagnostics.dispose()
  })
})
