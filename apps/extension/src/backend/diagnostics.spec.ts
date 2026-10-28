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
  it('rejects raw output, secrets, unknown fields and malformed versions at the connection log boundary', () => {
    const { channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    const progress = { phase: 'verification' as const, status: 'started' as const }
    diagnostics.connectionProgress({ ...progress, hostVersion: 'private-token-value' })
    diagnostics.connectionProgress(
      Object.assign(
        { ...progress },
        { endpoint: 'http://private', token: 'fixture-secret', message: 'raw output' },
      ),
    )
    expect(diagnostics.connectionOutput()).toEqual([])
    diagnostics.connectionProgress({ ...progress, hostVersion: '0.2.1-rc.2' })
    expect(diagnostics.connectionOutput()[0]?.hostVersion).toBe('0.2.1-rc.2')
    diagnostics.dispose()
  })
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
    // The value is replaced and the separator it matched is kept, so the
    // diagnostic still reads as the `token=…` pair it came from.
    expect(entry.fields.message).toContain('token=[redacted]')
    expect(entry.fields.stack).toContain('[redacted]')
    expect(entry.fields).not.toHaveProperty('pid')
    expect(entry.fields).not.toHaveProperty('endpoint')
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

  it('logs connection-lost with its sanitized reason and redacts any residual secret', () => {
    const { lines, channel } = fakeChannel()
    const diagnostics = new RedactedDiagnostics(channel)
    diagnostics.log('warn', 'connection-lost', {
      reason: 'DSH event stream disconnected (BACKEND_UNREACHABLE). token=super-secret',
    })

    expect(lines).toHaveLength(1)
    const entry = JSON.parse(lines[0] ?? '') as { event: string; fields: Record<string, string> }
    expect(entry.event).toBe('connection-lost')
    expect(entry.fields.reason).toContain('BACKEND_UNREACHABLE')
    expect(entry.fields.reason).not.toContain('super-secret')
    expect(entry.fields.reason).toContain('token=[redacted]')
    diagnostics.dispose()
  })
})
