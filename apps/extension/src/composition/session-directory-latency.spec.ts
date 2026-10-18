import { describe, expect, it, vi } from 'vitest'
import { listScopedSessions, type DirectoryDependencies } from './session-directory.js'

describe('scoped session directory latency', () => {
  it('starts session and archive reads together while retaining the archive and workspace boundary', async () => {
    let finish!: (ids: readonly string[]) => void
    const deps: DirectoryDependencies = {
      currentWorkspaceFolders: () => [],
      listCurrentWorkspaces: () =>
        Promise.resolve([
          { id: 'w1', name: 'Project', path: '/project', sessionCount: 0, createdAt: '', updatedAt: '' },
        ]),
      listCurrentArchivedSessionIds: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      sessionUseCases: {
        list: vi.fn().mockResolvedValue({
          items: [
            { id: 's1', workspaceId: 'w1' },
            { id: 'archived', workspaceId: 'w1' },
            { id: 'foreign', workspaceId: 'w2' },
          ],
        }),
      },
    }
    const pending = listScopedSessions(deps, {}, new AbortController().signal)
    await vi.waitFor(() => expect(deps.sessionUseCases.list).toHaveBeenCalledOnce())
    finish(['archived'])
    expect((await pending).items.map(({ id }) => id)).toEqual(['s1'])
  })

  it('does not start catalog work after workspace discovery was cancelled', async () => {
    const controller = new AbortController()
    const deps: DirectoryDependencies = {
      currentWorkspaceFolders: () => [],
      listCurrentWorkspaces: () => {
        controller.abort()
        return Promise.resolve([])
      },
      listCurrentArchivedSessionIds: vi.fn(),
      sessionUseCases: { list: vi.fn() },
    }
    await expect(listScopedSessions(deps, {}, controller.signal)).rejects.toThrow()
    expect(deps.listCurrentArchivedSessionIds).not.toHaveBeenCalled()
    expect(deps.sessionUseCases.list).not.toHaveBeenCalled()
  })
})
