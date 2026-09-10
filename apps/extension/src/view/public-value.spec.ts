import { describe, expect, it } from 'vitest'

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
