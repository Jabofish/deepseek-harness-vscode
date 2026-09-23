import { describe, expect, it } from 'vitest'

import { sessionWorkspaceFolderId } from './session-workspace-scope.js'

const samePath = (left: string, right: string): boolean =>
  left.replace(/\\/gu, '/').toLowerCase() === right.replace(/\\/gu, '/').toLowerCase()

describe('session workspace scope', () => {
  it('maps a session cwd to the folder that owns it', () => {
    expect(
      sessionWorkspaceFolderId({
        folders: [
          { id: 'workspace:alpha', path: 'D:/work/alpha' },
          { id: 'workspace:beta', path: 'D:/work/beta' },
        ],
        session: { cwd: 'd:\\work\\beta' },
        samePath,
      }),
    ).toBe('workspace:beta')
  })

  it('accepts the only open folder when the cwd belongs elsewhere', () => {
    expect(
      sessionWorkspaceFolderId({
        folders: [{ id: 'workspace:alpha', path: 'D:/work/alpha' }],
        session: { cwd: 'D:/tmp/elsewhere' },
        samePath,
      }),
    ).toBe('workspace:alpha')
  })

  it('stays unscoped when several folders match no cwd', () => {
    expect(
      sessionWorkspaceFolderId({
        folders: [
          { id: 'workspace:alpha', path: 'D:/work/alpha' },
          { id: 'workspace:beta', path: 'D:/work/beta' },
        ],
        session: { cwd: 'D:/tmp/elsewhere' },
        samePath,
      }),
    ).toBeUndefined()
  })

  it('states no scope without an open folder, even when a cwd exists', () => {
    // The extension-owned temporary workspace is a DSH workspace, not a VS
    // Code folder: path-scoped surfaces have no root to guard and must not
    // be reported as readable by guessing one.
    expect(
      sessionWorkspaceFolderId({
        folders: [],
        session: { cwd: 'C:/Users/user/AppData/Roaming/Code/workspace-3CV6Ni' },
        samePath,
      }),
    ).toBeUndefined()
  })
})
