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

  it('honors the configured verbosity instead of always appending every event', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel, () => 'error')

    diagnostics.log('debug', 'connection-state', { state: 'connecting' })
    diagnostics.log('info', 'connection-state', { state: 'connecting' })
    diagnostics.log('warn', 'host-message-rejected', { code: 'PROTOCOL_ERROR' })
    diagnostics.log('error', 'request-unexpected', { name: 'TypeError' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"level":"error"')
    diagnostics.dispose()
  })

  it('keeps info events visible at the default verbosity', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel, () => 'info')

    diagnostics.log('info', 'connection-state', { state: 'connected' })
    diagnostics.log('debug', 'connection-state', { state: 'connecting' })

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"level":"info"')
    diagnostics.dispose()
  })

  it('keeps a bounded recent ring without exposing secrets', () => {
    const { channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    for (let index = 0; index < 40; index += 1)
      diagnostics.log('info', 'connection-state', {
        state: index === 39 ? 'connected' : 'connecting',
        attempt: index,
        message: `token=secret-${index}`,
      })

    const recent = diagnostics.recentEvents()
    expect(recent).toHaveLength(32)
    expect(recent[0]).toContain('"attempt":8')
    expect(recent.at(-1)).toContain('connected')
    expect(recent.join('\n')).not.toContain('token=secret-')
    expect(diagnostics.recentEvents(2)).toHaveLength(2)
    expect(diagnostics.recentEvents(0)).toEqual([])
    diagnostics.dispose()
  })

  it('does not expose exception stacks and absolute paths through the Webview snapshot', () => {
    const { channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    const privatePath = 'C:\\Users\\fixture-user\\private-project\\source.ts'

    diagnostics.log('error', 'request-unexpected', {
      requestType: 'session.open',
      name: '{"name":"token=secret-in-error-name","stack":"at open (C:\\Users\\fixture-user\\private-project\\source.ts)"}',
      message: `Unable to open ${privatePath}`,
      stack: `at open (${privatePath}:4:2)`,
      state: '{"message":"private serialized details"}',
    })

    const recent = diagnostics.recentEvents()
    expect(recent).toHaveLength(1)
    const snapshotLine = recent[0] ?? ''
    const snapshotEntry = JSON.parse(snapshotLine) as { fields: Record<string, unknown> }
    expect(snapshotEntry.fields).toEqual({ requestType: 'session.open', errorKind: 'Error' })
    expect(snapshotLine).not.toContain('fixture-user')
    expect(snapshotLine).not.toContain('secret-in-error-name')
    expect(snapshotLine).not.toContain('private serialized details')
    expect(snapshotLine).not.toContain('at open')
    diagnostics.dispose()
  })

  it('retains a safe error class name in the readable snapshot', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    diagnostics.log('error', 'request-unexpected', {
      requestType: 'session.open',
      name: 'TypeError',
      message: 'The host operation failed.',
      stack: 'at open (internal.ts:4:2)',
    })

    const snapshotLine = diagnostics.recentEvents()[0] ?? ''
    const snapshotEntry = JSON.parse(snapshotLine) as { fields: Record<string, unknown> }
    expect(snapshotEntry.fields).toEqual({ requestType: 'session.open', errorKind: 'TypeError' })
    expect(lines[0]).toContain('The host operation failed.')
    expect(lines[0]).toContain('at open')
    diagnostics.dispose()
  })

  it('normalizes unknown event names before writing local or public diagnostics', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    const privateEvent = 'secret-CUsers-fixture-private-project-token'

    diagnostics.log('warn', privateEvent, { state: 'connected' })

    const snapshotLine = diagnostics.recentEvents()[0] ?? ''
    const snapshotEntry = JSON.parse(snapshotLine) as { event: string }
    expect(snapshotEntry.event).toBe('diagnostic')
    expect(snapshotLine).not.toContain(privateEvent)
    expect(lines[0]).toContain('"event":"diagnostic"')
    expect(lines[0]).not.toContain(privateEvent)
    diagnostics.dispose()
  })
})
