import path from 'node:path'

import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'
import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  TemporaryWorkspaceManager,
  type LegacyTemporaryWorkspaceReference,
  type StoredTemporaryWorkspace,
} from './temporary-workspace.js'

const rootPath = path.join(process.cwd(), 'temporary-workspace-root')

type WorkspaceCreator = (input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>
type DirectoryEnsurer = (directoryPath: string) => Promise<void>
type DirectoryCreator = (prefix: string) => Promise<string>
type OwnershipMarkerCreator = (directoryPath: string, expectedOwnershipToken?: string) => Promise<string>
type OwnershipMarkerReader = (
  directoryPath: string,
  expectedOwnershipToken?: string,
) => Promise<string | undefined>
type OwnershipMarkerRemover = (directoryPath: string, ownershipToken: string) => Promise<void>
type DirectoryRemover = (directoryPath: string) => Promise<void>
type ReferencePersister = (reference: StoredTemporaryWorkspace | undefined) => Promise<void>

const persistedOwnershipToken = '11111111-1111-4111-8111-111111111111'
const createdOwnershipToken = '22222222-2222-4222-8222-222222222222'

interface TemporaryWorkspaceHarness {
  readonly manager: TemporaryWorkspaceManager
  readonly createWorkspace: Mock<WorkspaceCreator>
  readonly ensureDirectory: Mock<DirectoryEnsurer>
  readonly createDirectoryExclusive: Mock<DirectoryEnsurer>
  readonly createTemporaryDirectory: Mock<DirectoryCreator>
  readonly createOwnershipMarker: Mock<OwnershipMarkerCreator>
  readonly readOwnershipMarker: Mock<OwnershipMarkerReader>
  readonly removeOwnershipMarker: Mock<OwnershipMarkerRemover>
  readonly removeDirectory: Mock<DirectoryRemover>
  readonly persistReference: Mock<ReferencePersister>
  readonly seedOwnershipMarker: (directoryPath: string, ownershipToken?: string) => void
  readonly removeManagedDirectory: (directoryPath: string) => void
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

function createHarness(
  initialReference?: StoredTemporaryWorkspace,
  initialLegacyReference?: LegacyTemporaryWorkspaceReference,
  legacyPathKind: 'directory' | 'missing' | 'symlink' = 'directory',
): TemporaryWorkspaceHarness {
  const createWorkspace = vi
    .fn<(input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>>()
    .mockImplementation((input) => Promise.resolve(workspace('created-workspace', input.path)))
  const managedDirectories = new Set<string>()
  if (initialReference !== undefined) managedDirectories.add(path.resolve(initialReference.path))
  if (initialLegacyReference !== undefined && legacyPathKind !== 'missing')
    managedDirectories.add(path.resolve(initialLegacyReference.path))
  const symbolicLinks = new Set<string>()
  if (initialLegacyReference !== undefined && legacyPathKind === 'symlink')
    symbolicLinks.add(path.resolve(initialLegacyReference.path))
  const ensureDirectory = vi.fn<DirectoryEnsurer>().mockImplementation((directoryPath) => {
    managedDirectories.add(path.resolve(directoryPath))
    return Promise.resolve()
  })
  const createDirectoryExclusive = vi.fn<DirectoryEnsurer>().mockImplementation((directoryPath) => {
    const normalized = path.resolve(directoryPath)
    if (managedDirectories.has(normalized)) return Promise.reject(new Error('EEXIST'))
    managedDirectories.add(normalized)
    return Promise.resolve()
  })
  const temporaryPath = path.join(rootPath, 'workspace-1')
  const createTemporaryDirectory = vi.fn<DirectoryCreator>().mockImplementation(() => {
    managedDirectories.add(path.resolve(temporaryPath))
    return Promise.resolve(temporaryPath)
  })
  const ownershipMarkers = new Map<string, string>()
  if (initialReference !== undefined)
    ownershipMarkers.set(path.resolve(initialReference.path), initialReference.ownershipToken)
  const createOwnershipMarker = vi.fn<OwnershipMarkerCreator>().mockImplementation((directoryPath) => {
    const key = path.resolve(directoryPath)
    const existingToken = ownershipMarkers.get(key)
    if (existingToken !== undefined) return Promise.resolve(existingToken)
    ownershipMarkers.set(key, createdOwnershipToken)
    return Promise.resolve(createdOwnershipToken)
  })
  const readOwnershipMarker = vi
    .fn<OwnershipMarkerReader>()
    .mockImplementation((directoryPath) => Promise.resolve(ownershipMarkers.get(path.resolve(directoryPath))))
  const removeOwnershipMarker = vi.fn<OwnershipMarkerRemover>().mockImplementation((directoryPath) => {
    ownershipMarkers.delete(path.resolve(directoryPath))
    return Promise.resolve()
  })
  const removeDirectory = vi.fn<DirectoryRemover>().mockImplementation((directoryPath) => {
    managedDirectories.delete(path.resolve(directoryPath))
    return Promise.resolve()
  })
  const persistReference = vi
    .fn<(reference: StoredTemporaryWorkspace | undefined) => Promise<void>>()
    .mockResolvedValue(undefined)
  const isManagedPath = (candidatePath: string): boolean => {
    const normalizedRoot = path.resolve(rootPath)
    const normalizedCandidate = path.resolve(candidatePath)
    return (
      managedDirectories.has(normalizedCandidate) &&
      !symbolicLinks.has(normalizedCandidate) &&
      path.dirname(normalizedCandidate) === normalizedRoot &&
      path.basename(normalizedCandidate).startsWith('workspace-')
    )
  }
  const isManagedPathMissing = (candidatePath: string): boolean => {
    const normalizedRoot = path.resolve(rootPath)
    const normalizedCandidate = path.resolve(candidatePath)
    return (
      !managedDirectories.has(normalizedCandidate) &&
      path.dirname(normalizedCandidate) === normalizedRoot &&
      path.basename(normalizedCandidate).startsWith('workspace-')
    )
  }
  const manager = new TemporaryWorkspaceManager({
    rootPath,
    ...(initialReference === undefined ? {} : { initialReference }),
    ...(initialLegacyReference === undefined ? {} : { initialLegacyReference }),
    createWorkspace,
    ensureDirectory,
    createDirectoryExclusive,
    createTemporaryDirectory,
    createOwnershipMarker,
    readOwnershipMarker,
    removeOwnershipMarker,
    removeOwnedDirectory: (directoryPath) => removeDirectory(directoryPath),
    isManagedPath,
    isManagedPathMissing,
    samePath: (left, right) => path.resolve(left) === path.resolve(right),
    persistReference,
  })

  return {
    manager,
    createWorkspace,
    ensureDirectory,
    createDirectoryExclusive,
    createTemporaryDirectory,
    createOwnershipMarker,
    readOwnershipMarker,
    removeOwnershipMarker,
    removeDirectory,
    persistReference,
    seedOwnershipMarker: (directoryPath, ownershipToken) => {
      managedDirectories.add(path.resolve(directoryPath))
      if (ownershipToken === undefined) ownershipMarkers.delete(path.resolve(directoryPath))
      else ownershipMarkers.set(path.resolve(directoryPath), ownershipToken)
    },
    removeManagedDirectory: (directoryPath) => {
      managedDirectories.delete(path.resolve(directoryPath))
    },
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
    expect(harness.createOwnershipMarker).toHaveBeenCalledWith(temporaryPath)
    expect(harness.persistReference).toHaveBeenCalledWith({
      id: 'created-workspace',
      path: temporaryPath,
      ownershipToken: createdOwnershipToken,
    })
  })

  it('reuses a matching persisted registry entry without creating another workspace', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'persisted-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    const existing = workspace('persisted-workspace', temporaryPath)

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject(existing)
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.persistReference).not.toHaveBeenCalled()
  })

  it('migrates a legacy id and path only when the DSH registry matches both exactly', async () => {
    const legacy = {
      id: 'legacy-workspace',
      path: path.join(rootPath, 'workspace-legacy'),
    }
    const existing = workspace(legacy.id, legacy.path)
    const harness = createHarness(undefined, legacy)

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject(existing)
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.createOwnershipMarker).toHaveBeenCalledWith(legacy.path)
    expect(harness.persistReference).toHaveBeenCalledWith({
      ...legacy,
      ownershipToken: createdOwnershipToken,
    })
    expect(harness.manager.reference).toEqual({ ...legacy, ownershipToken: createdOwnershipToken })
  })

  it.each([
    ['id mismatch', 'other-workspace', path.join(rootPath, 'workspace-legacy')],
    ['path mismatch', 'legacy-workspace', path.join(rootPath, 'workspace-other')],
  ])(
    'does not migrate a legacy reference when the DSH registry has an %s',
    async (_case, id, workspacePath) => {
      const legacy = {
        id: 'legacy-workspace',
        path: path.join(rootPath, 'workspace-legacy'),
      }
      const harness = createHarness(undefined, legacy)

      const result = await harness.manager.resolve([workspace(id, workspacePath)])

      expect(result.path).toBe(path.join(rootPath, 'workspace-1'))
      expect(harness.createOwnershipMarker).not.toHaveBeenCalledWith(legacy.path)
      expect(harness.removeDirectory).not.toHaveBeenCalledWith(legacy.path)
      expect(harness.manager.reference).not.toEqual({ ...legacy, ownershipToken: createdOwnershipToken })
    },
  )

  it.each([
    ['symbolic link', 'symlink'],
    ['missing directory', 'missing'],
  ] as const)('does not migrate a legacy %s', async (_case, legacyPathKind) => {
    const legacy = {
      id: 'legacy-workspace',
      path: path.join(rootPath, 'workspace-legacy'),
    }
    const existing = workspace(legacy.id, legacy.path)
    const harness = createHarness(undefined, legacy, legacyPathKind)

    const result = await harness.manager.resolve([existing])

    expect(result.path).toBe(path.join(rootPath, 'workspace-1'))
    expect(harness.createOwnershipMarker).not.toHaveBeenCalledWith(legacy.path)
    expect(harness.removeDirectory).not.toHaveBeenCalledWith(legacy.path)
  })

  it('re-registers the persisted path when DSH no longer lists the workspace', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'old-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })

    const result = await harness.manager.resolve([])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.ensureDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.createWorkspace).toHaveBeenCalledWith(
      { name: 'Temporary Workspace', path: temporaryPath },
      undefined,
    )
  })

  it('adopts a managed registry entry when persisted extension state is missing', async () => {
    const existing = workspace('recoverable-workspace', path.join(rootPath, 'workspace-2'))
    const harness = createHarness()
    harness.seedOwnershipMarker(existing.path ?? '', persistedOwnershipToken)

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject(existing)
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.persistReference).toHaveBeenCalledWith({
      id: existing.id,
      path: existing.path,
      ownershipToken: persistedOwnershipToken,
    })
  })

  it('does not adopt an unmarked same-named registry path as an extension workspace', async () => {
    const forged = workspace('unowned-workspace', path.join(rootPath, 'workspace-forged'))
    const harness = createHarness()
    harness.seedOwnershipMarker(forged.path ?? '')

    const result = await harness.manager.resolve([forged])

    expect(result).toMatchObject({ id: 'created-workspace', path: path.join(rootPath, 'workspace-1') })
    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(forged.path)
    expect(harness.removeDirectory).not.toHaveBeenCalledWith(forged.path)
  })

  it('restores a persisted workspace after restart when the ownership marker matches', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'persisted-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })

    const result = await harness.manager.resolve([])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(harness.createOwnershipMarker).not.toHaveBeenCalled()
    expect(harness.createWorkspace).toHaveBeenCalledWith(
      { name: 'Temporary Workspace', path: temporaryPath },
      undefined,
    )
  })

  it('recreates a missing workspace directory from its matching sidecar after restart', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'persisted-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    harness.removeManagedDirectory(temporaryPath)

    const result = await harness.manager.resolve([workspace('persisted-workspace', temporaryPath)])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.createDirectoryExclusive).toHaveBeenCalledWith(temporaryPath)
    expect(harness.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(harness.createOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
  })

  it('recovers a missing directory from a sidecar when extension state was lost', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-2')
    const existing = workspace('recoverable-workspace', temporaryPath)
    const harness = createHarness()
    harness.seedOwnershipMarker(temporaryPath, persistedOwnershipToken)
    harness.removeManagedDirectory(temporaryPath)

    const result = await harness.manager.resolve([existing])

    expect(result).toMatchObject({ id: 'created-workspace', path: temporaryPath })
    expect(harness.createDirectoryExclusive).toHaveBeenCalledWith(temporaryPath)
    expect(harness.createTemporaryDirectory).not.toHaveBeenCalled()
    expect(harness.createOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.persistReference).toHaveBeenNthCalledWith(1, {
      id: existing.id,
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
  })

  it('does not trust a persisted same-named path when its ownership marker is missing', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-forged')
    const existing = workspace('forged-workspace', temporaryPath)
    const harness = createHarness({
      id: existing.id,
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    harness.seedOwnershipMarker(temporaryPath)

    const result = await harness.manager.resolve([existing])

    expect(result.path).toBe(path.join(rootPath, 'workspace-1'))
    expect(harness.persistReference).toHaveBeenNthCalledWith(1, undefined)
    expect(harness.removeDirectory).not.toHaveBeenCalledWith(temporaryPath)
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
    harness.removeDirectory.mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(harness.manager.resolve([])).rejects.toThrow('registration failed')

    expect(harness.removeDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.manager.current).toBeUndefined()
    expect(harness.manager.reference).toBeUndefined()
    expect(harness.persistReference).not.toHaveBeenCalled()
    expect(harness.removeOwnershipMarker).not.toHaveBeenCalled()
  })

  it('cleans up the ownership sidecar after a failed registration removes its directory', async () => {
    const harness = createHarness()
    const temporaryPath = path.join(rootPath, 'workspace-1')
    harness.createWorkspace.mockRejectedValueOnce(new Error('registration failed'))

    await expect(harness.manager.resolve([])).rejects.toThrow('registration failed')

    expect(harness.removeDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.removeOwnershipMarker).toHaveBeenCalledWith(temporaryPath, createdOwnershipToken)
    expect(harness.removeDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      harness.removeOwnershipMarker.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('keeps a newly created directory when ownership marker creation fails without returning a token', async () => {
    const harness = createHarness()
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const markerWriteError = new Error('partial ownership marker write')
    harness.createOwnershipMarker.mockRejectedValueOnce(markerWriteError)

    await expect(harness.manager.resolve([])).rejects.toBe(markerWriteError)

    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath)
    expect(harness.removeDirectory).not.toHaveBeenCalled()
    expect(harness.removeOwnershipMarker).not.toHaveBeenCalled()
    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.persistReference).not.toHaveBeenCalled()
  })

  it('does not register or remove a newly created directory when marker creation returns no token', async () => {
    const harness = createHarness()
    const temporaryPath = path.join(rootPath, 'workspace-1')
    harness.createOwnershipMarker.mockResolvedValueOnce(undefined as unknown as string)

    await expect(harness.manager.resolve([])).rejects.toThrow('valid extension ownership token')

    expect(harness.createWorkspace).not.toHaveBeenCalled()
    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath)
    expect(harness.removeDirectory).not.toHaveBeenCalled()
    expect(harness.removeOwnershipMarker).not.toHaveBeenCalled()
    expect(harness.persistReference).not.toHaveBeenCalled()
  })

  it('does not clean up a failed creation outside the managed direct-child boundary', async () => {
    const unownedPath = path.join(process.cwd(), 'workspace-unowned')
    const harness = createHarness()
    harness.createTemporaryDirectory.mockResolvedValueOnce(unownedPath)
    harness.createWorkspace.mockRejectedValueOnce(new Error('registration failed'))

    await expect(harness.manager.resolve([])).rejects.toThrow('registration failed')

    expect(harness.createOwnershipMarker).toHaveBeenCalledWith(unownedPath)
    expect(harness.removeDirectory).not.toHaveBeenCalled()
  })

  it('removes the directory before clearing a forgotten workspace reference', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const existing = workspace('persisted-workspace', temporaryPath)
    const harness = createHarness({
      id: existing.id,
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    await harness.manager.resolve([existing])
    harness.persistReference.mockClear()

    await harness.manager.forget(true)

    expect(harness.removeDirectory).toHaveBeenCalledWith(temporaryPath)
    expect(harness.removeOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.persistReference).toHaveBeenCalledWith(undefined)
    expect(harness.removeDirectory.mock.invocationCallOrder[0]).toBeLessThan(
      harness.removeOwnershipMarker.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(harness.removeOwnershipMarker.mock.invocationCallOrder[0]).toBeLessThan(
      harness.persistReference.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
    expect(harness.manager.current).toBeUndefined()
    expect(harness.manager.reference).toBeUndefined()
  })

  it('retains a failed deletion for a later forget retry', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const existing = workspace('persisted-workspace', temporaryPath)
    const harness = createHarness({
      id: existing.id,
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    await harness.manager.resolve([existing])
    harness.persistReference.mockClear()
    harness.removeDirectory.mockRejectedValueOnce(new Error('directory is busy'))

    await expect(harness.manager.forget(true)).rejects.toThrow('directory is busy')

    expect(harness.manager.current).toMatchObject(existing)
    expect(harness.manager.reference).toEqual({
      id: existing.id,
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    expect(harness.persistReference).not.toHaveBeenCalled()
    expect(harness.removeOwnershipMarker).not.toHaveBeenCalled()

    await harness.manager.forget(true)

    expect(harness.removeDirectory).toHaveBeenCalledTimes(2)
    expect(harness.removeOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.persistReference).toHaveBeenCalledWith(undefined)
    expect(harness.manager.current).toBeUndefined()
    expect(harness.manager.reference).toBeUndefined()
  })

  it('retries sidecar cleanup after the workspace directory was already removed', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'persisted-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    await harness.manager.resolve([workspace('persisted-workspace', temporaryPath)])
    harness.persistReference.mockClear()
    harness.removeOwnershipMarker.mockRejectedValueOnce(new Error('sidecar is busy'))

    await expect(harness.manager.forget(true)).rejects.toThrow('sidecar is busy')

    expect(harness.removeDirectory).toHaveBeenCalledTimes(1)
    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.persistReference).not.toHaveBeenCalled()

    await harness.manager.forget(true)

    expect(harness.removeDirectory).toHaveBeenCalledTimes(1)
    expect(harness.removeOwnershipMarker).toHaveBeenCalledTimes(2)
    expect(harness.persistReference).toHaveBeenCalledWith(undefined)
    expect(harness.manager.reference).toBeUndefined()
  })

  it('does not delete a direct workspace directory after its ownership marker changes', async () => {
    const temporaryPath = path.join(rootPath, 'workspace-1')
    const harness = createHarness({
      id: 'persisted-workspace',
      path: temporaryPath,
      ownershipToken: persistedOwnershipToken,
    })
    harness.seedOwnershipMarker(temporaryPath)

    await harness.manager.forget(true)

    expect(harness.readOwnershipMarker).toHaveBeenCalledWith(temporaryPath, persistedOwnershipToken)
    expect(harness.removeDirectory).not.toHaveBeenCalled()
    expect(harness.persistReference).toHaveBeenCalledWith(undefined)
  })

  it('rejects an unsafe persisted path and never treats it as extension-owned', async () => {
    const unsafePath = path.join(process.cwd(), 'user-project')
    const harness = createHarness({
      id: 'unsafe-workspace',
      path: unsafePath,
      ownershipToken: persistedOwnershipToken,
    })

    const result = await harness.manager.resolve([])

    expect(result.path).toBe(path.join(rootPath, 'workspace-1'))
    expect(harness.persistReference).toHaveBeenNthCalledWith(1, undefined)
    expect(harness.removeDirectory).not.toHaveBeenCalledWith(unsafePath)
  })
})
