import { describe, expect, it } from 'vitest'
import { rc6Mapper } from '@dsh-vscode/dsh-adapter'

import { publicWorkspaceRelativePath, publicWorkspaceSummary, sanitizePublicValue } from './public-value.js'

describe('public Webview value projection', () => {
  it('removes workspace paths while retaining opaque membership ids', () => {
    expect(
      publicWorkspaceSummary({
        id: 'workspace-1',
        name: 'Project',
        path: 'C:\\Users\\alice\\project',
        sessionIds: ['session-1'],
        createdAt: '2026-09-06T00:00:00.000Z',
        updatedAt: '2026-09-06T00:00:00.000Z',
        sessionCount: 1,
      }),
    ).toEqual({
      id: 'workspace-1',
      name: 'Project',
      sessionIds: ['session-1'],
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
      sessionCount: 1,
    })
  })

  it('removes cwd and host home from nested payloads without deleting product fields', () => {
    expect(
      sanitizePublicValue({
        cwd: 'C:\\Users\\alice\\project',
        home: 'C:\\Users\\alice',
        projection: { key: 'goal', value: { prompt: 'visible product text' } },
        usage: { inputTokens: 12, outputTokens: 8 },
      }),
    ).toEqual({
      projection: { key: 'goal', value: { prompt: 'visible product text' } },
      usage: { inputTokens: 12, outputTokens: 8 },
    })
  })

  it('keeps an approval command preview while still removing a process command line', () => {
    expect(
      sanitizePublicValue({
        type: 'permission.requested',
        request: {
          id: 'approval-1',
          sessionId: 'session-1',
          title: 'Run command',
          description: 'DSH requested permission to continue.',
          commandLine: 'rm -rf build',
          risk: 'medium',
          options: [{ id: 'allowed-once', label: 'Allow once', kind: 'allow-once' }],
        },
      }),
    ).toEqual({
      type: 'permission.requested',
      request: {
        id: 'approval-1',
        sessionId: 'session-1',
        title: 'Run command',
        description: 'DSH requested permission to continue.',
        commandLine: 'rm -rf build',
        risk: 'medium',
        options: [{ id: 'allowed-once', label: 'Allow once', kind: 'allow-once' }],
      },
    })
    // A discovered DSH process command line is Host-only discovery data.
    expect(sanitizePublicValue({ runner: { commandLine: 'dsh --token=secret', pid: 42 } })).toEqual({
      runner: {},
    })
  })

  it('crosses the boundary with a derived running command while cwd stays Host-only', () => {
    // A host without a view envelope leaves the running command to the adapter,
    // which reads it off the call's own arguments. The renderer needs that
    // command (an approval is decided by it), while the resolved working
    // directory stays on the privileged side.
    const event = rc6Mapper.event('tool/call', {
      sessionId: 'session-1',
      data: {
        callId: 'call-bash',
        name: 'bash',
        arguments: JSON.stringify({
          command: 'pnpm check',
          description: 'Run the repository checks',
          workdir: 'C:\\Users\\alice\\project',
        }),
      },
    })
    const publicEvent = sanitizePublicValue(event) as { tool: { presentation: unknown } }
    expect(publicEvent.tool.presentation).toEqual({
      phase: 'call',
      card: 'terminal',
      title: 'pnpm check',
      description: 'Run the repository checks',
    })
    expect(JSON.stringify(publicEvent.tool.presentation)).not.toContain('alice')
  })

  it('projects absolute or traversing delivered paths only when they stay in an owned root', () => {
    const root = process.platform === 'win32' ? 'C:\\workspace' : '/workspace'
    expect(publicWorkspaceRelativePath('artifacts/report.txt', root, [root])).toBe('artifacts/report.txt')
    expect(
      publicWorkspaceRelativePath(
        process.platform === 'win32'
          ? 'C:\\workspace\\artifacts\\report.txt'
          : '/workspace/artifacts/report.txt',
        root,
        [root],
      ),
    ).toBe('artifacts/report.txt')
    expect(publicWorkspaceRelativePath('../outside.txt', root, [root])).toBeUndefined()
    expect(
      publicWorkspaceRelativePath(process.platform === 'win32' ? 'C:\\outside.txt' : '/outside.txt', root, [
        root,
      ]),
    ).toBeUndefined()
  })
})
