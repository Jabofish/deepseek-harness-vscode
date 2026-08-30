import path from 'node:path'

import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'
import { describe, expect, it, vi, type Mock } from 'vitest'

import { TemporaryWorkspaceManager, type StoredTemporaryWorkspace } from './temporary-workspace.js'

const rootPath = path.join(process.cwd(), 'temporary-workspace-root')

type WorkspaceCreator = (input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>
type DirectoryEnsurer = (directoryPath: string) => Promise<void>
type DirectoryCreator = (prefix: string) => Promise<string>
type DirectoryRemover = (directoryPath: string) => Promise<void>
type ReferencePersister = (reference: StoredTemporaryWorkspace | undefined) => Promise<void>

interface TemporaryWorkspaceHarness {
  readonly manager: TemporaryWorkspaceManager
  readonly createWorkspace: Mock<WorkspaceCreator>
  readonly ensureDirectory: Mock<DirectoryEnsurer>
  readonly createTemporaryDirectory: Mock<DirectoryCreator>
  readonly removeDirectory: Mock<DirectoryRemover>
  readonly persistReference: Mock<ReferencePersister>
}

function workspace(id: string, workspacePath: string): WorkspaceSummary {
  return {
    id,
    name: 'Temporary Workspace',
    path: workspacePath,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    sessionCount: 0,
  }
}

function createHarness(initialReference?: StoredTemporaryWorkspace): TemporaryWorkspaceHarness {
  const createWorkspace = vi
    .fn<(input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>>()
    .mockImplementation((input) => Promise.resolve(workspace('created-workspace', input.path)))
  const ensureDirectory = vi.fn<(directoryPath: string) => Promise<void>>().mockResolvedValue(undefined)
  const createTemporaryDirectory = vi
    .fn<(prefix: string) => Promise<string>>()
    .mockResolvedValue(path.join(rootPath, 'workspace-1'))
  const removeDirectory = vi.fn<(directoryPath: string) => Promise<void>>().mockResolvedValue(undefined)
  const persistReference = vi
    .fn<(reference: StoredTemporaryWorkspace | undefined) => Promise<void>>()
    .mockResolvedValue(undefined)
  const isManagedPath = (candidatePath: string): boolean => {
    const normalizedRoot = path.resolve(rootPath)
    const normalizedCandidate = path.resolve(candidatePath)
    return (
      path.dirname(normalizedCandidate) === normalizedRoot &&
      path.basename(normalizedCandidate).startsWith('workspace-')
    )
  }
  const manager = new TemporaryWorkspaceManager({
    rootPath,
    ...(initialReference === undefined ? {} : { initialReference }),
    createWorkspace,
    ensureDirectory,
    createTemporaryDirectory,
    removeDirectory,
    isManagedPath,
    samePath: (left, right) => path.resolve(left) === path.resolve(right),
    persistReference,
  })

  return {
    manager,
    createWorkspace,
    ensureDirectory,
    createTemporaryDirectory,
    removeDirectory,
    persistReference,
  }
}

describe('TemporaryWorkspaceManager', () => {
  it('creates and persists a managed workspace when the registry is empty', async () => {
    const harness = createHarness()
    const temporaryPath = path.join(rootPath, 'workspace-1')

    const result = await harness.manager.resolve([])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.createTemporaryDirectory).toHaveBeenCalledWith(path.join(rootPath, 'workspace-'))
    expect(harness.createWorkspace).toHaveBeenCalledWith(
      { name: 'Temporary Workspace', path: temporaryPath },
      undefined,
    )
    expect(harness.persistReference).toHaveBeenCalledWith({
      id: 'created-workspace',
      path: temporaryPath,
    })
  })

  it('reuses a matching persisted registry entry without creating another workspace', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({ id: 'persisted-workspace', path: temporaryPath })
    const existing = workspace('persisted-workspace', temporaryPath)

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject(existing)
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.persistReference).not.toHaveBeenCalled()
  })

  it('re-registers the persisted path when DSH no longer lists the workspace', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({ id: 'old-workspace', path: temporaryPath })

    const result = await harness.manager.resolve([])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.ensureDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(harness.createWorkspace).toHaveBeenCalledWith(
      { name: 'Temporary Workspace', path: temporaryPath },
      undefined,
    )
  })

  it('adopts a managed registry entry when persisted extension state is missing', async () => {
    const existing = workspace('recoverable-workspace', path.join(rootPath, 'workspace-2'))
    const harness = createHarness()

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject(existing)
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.persistReference).toHaveBeenCalledWith({
      id: existing.id,
      path: existing.path,
    })
  })

  it('serializes concurrent first lookups into one create request', async () => {
    const harness = createHarness()
    let release: ((value: WorkspaceSummary) => void) | undefined
    const pending = new Promise<WorkspaceSummary>((resolve) => {
      release = resolve
    })
    harness.createWorkspace.mockReturnValueOnce(pending)

    const first = harness.manager.resolve([])
    const second = harness.manager.resolve([])
    await vi.waitFor(() => expect(harness.createWorkspace).toHaveBeenCalledTimes(1))

    release?.(workspace('concurrent-workspace', path.join(rootPath, 'workspace-1')))
    const results = await Promise.all([first, second])

    expect(results[0]).toMatchObject({ id: 'concurrent-workspace' })
    expect(results[1]).toMatchObject({ id: 'concurrent-workspace' })
    expect(harness.createTemporaryDirectory).toHaveBeenCalledTimes(1)
    expect(harness.createWorkspace).toHaveBeenCalledTimes(1)
  })

  it('cleans up a newly created directory when workspace registration fails', async () => {
    const harness = createHarness()
    const temporaryPath = path.join(rootPath, 'workspace-1')
    harness.createWorkspace.mockRejectedValueOnce(new Error('registration failed'))

    await expect(harness.manager.resolve([])).rejects.toThrow('registration failed')

    expect(harness.removeDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.manager.current).toBeUndefined()
  })

  it('rejects an unsafe persisted path and never treats it as extension-owned', async () => {
    const unsafePath = path.join(process.cwd(), 'user-project')
    const harness = createHarness({ id: 'unsafe-workspace', path: unsafePath })

    const result = await harness.manager.resolve([])

    expect(result.path).toBe(path.join(rootPath, 'workspace-1'))
    expect(harness.persistReference).toHaveBeenNthCalledWith(1, undefined)
    expect(harness.removeDirectory).not.toHaveBeenCalledWith(unsafePath)
  })
})
