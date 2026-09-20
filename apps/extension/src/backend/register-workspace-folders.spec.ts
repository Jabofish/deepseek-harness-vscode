import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceSummary } from '@dsh-vscode/domain'
import { registerWorkspaceFolders } from './register-workspace-folders.js'

const workspace = (path: string): WorkspaceSummary => ({
  id: path,
  path,
  name: path,
  createdAt: '',
  updatedAt: '',
  sessionCount: 0,
})
const samePath = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

describe('workspace folder registration', () => {
  it('registers a newly added root even when another is already registered, without renaming it', async () => {
    const create = vi.fn(({ path }: { path: string }) => Promise.resolve(workspace(path)))
    const existing = workspace('/one')
    const result = await registerWorkspaceFolders(
      ['/ONE', '/two'],
      [existing, workspace('/outside')],
      create,
      samePath,
      true,
    )
    expect(result).toEqual([existing, workspace('/two')])
    expect(create).toHaveBeenCalledExactlyOnceWith({ name: 'two', path: '/two' }, undefined)
  })

  it('keeps usable roots after one registration fails and retries on the next refresh', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(workspace('/two'))
    expect(await registerWorkspaceFolders(['/one', '/two'], [], create, samePath, true)).toEqual([
      workspace('/two'),
    ])
    create.mockResolvedValue(workspace('/one'))
    expect(
      await registerWorkspaceFolders(['/one', '/two'], [workspace('/two')], create, samePath, true),
    ).toEqual([workspace('/two'), workspace('/one')])
  })

  it('does not register directories before workspace trust is granted', async () => {
    const create = vi.fn()
    expect(
      await registerWorkspaceFolders(['/one', '/two'], [workspace('/one')], create, samePath, false),
    ).toEqual([workspace('/one')])
    expect(create).not.toHaveBeenCalled()
  })

  it('propagates cancellation and never starts the next registration', async () => {
    const controller = new AbortController()
    const create = vi.fn(() => {
      controller.abort()
      return Promise.reject(new Error('cancelled'))
    })
    await expect(
      registerWorkspaceFolders(['/one', '/two'], [], create, samePath, true, controller.signal),
    ).rejects.toThrow()
    expect(create).toHaveBeenCalledTimes(1)
  })
})
