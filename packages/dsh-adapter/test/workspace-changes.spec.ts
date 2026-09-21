import { describe, expect, it, vi } from 'vitest'
import { workspaceChangeSource } from '../src/versions/alpha162/workspace-changes.js'
import type { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'

describe('authoritative workspace change source', () => {
  it('keeps all hunks and honors missing process-local snapshots', async () => {
    const readChanges = vi
      .fn()
      .mockResolvedValueOnce({ turn: 2, total: 1, files: [{ path: 'a.ts', added: 1, deleted: 1 }] })
      .mockResolvedValueOnce({
        kind: 'text',
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
          { oldStart: 8, oldLines: 0, newStart: 8, newLines: 1, lines: ['+last'] },
        ],
      })
      .mockResolvedValueOnce(undefined)
    const source = workspaceChangeSource({ readChanges } as unknown as AlphaLoopbackApiClient)
    expect(await source.summary('s', 4)).toMatchObject({
      files: [{ path: 'a.ts', additions: 1, diffAvailable: true }],
    })
    expect(await source.diff('s', 4, 0)).toBe('@@ -1,1 +1,1 @@\n-old\n+new\n@@ -8,0 +8,1 @@\n+last')
    expect(await source.summary('s', 4)).toBeUndefined()
  })
  it('rejects malformed counts and hunks', async () => {
    const source = workspaceChangeSource({
      readChanges: vi
        .fn()
        .mockResolvedValue({ turn: 1, total: 1, files: [{ path: 'a', added: -1, deleted: 0 }] }),
    } as unknown as AlphaLoopbackApiClient)
    await expect(source.summary('s', 1)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
