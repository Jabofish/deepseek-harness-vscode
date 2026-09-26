import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { WorkspaceCreateInput, WorkspaceSummary } from '@dsh-vscode/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isManagedTemporaryWorkspaceLocation,
  isManagedTemporaryWorkspacePath,
  isManagedTemporaryWorkspacePathMissing,
} from './path-safety.js'
import { TemporaryWorkspaceManager } from './temporary-workspace.js'
import { TemporaryWorkspaceOwnershipStore } from './temporary-workspace-ownership.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-temporary-workspace-owner-'))
  temporaryRoots.push(root)
  return root
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class SameContentsMarkerReplacementStore extends TemporaryWorkspaceOwnershipStore {
  private snapshotCalls = 0
  private replaceOnSnapshotCall: number | undefined

  public constructor(private readonly root: string) {
    super(root)
  }

  public armReplacement(snapshotCall: number): void {
    this.snapshotCalls = 0
    this.replaceOnSnapshotCall = snapshotCall
  }

  protected override async readMarkerSnapshot(directoryPath: string): Promise<
    | {
        readonly contents: string
        readonly identity: { readonly device: string; readonly inode: string }
      }
    | undefined
  > {
    this.snapshotCalls += 1
    if (this.snapshotCalls === this.replaceOnSnapshotCall) {
      const markerPath = path.join(this.root, `.${path.basename(directoryPath)}.dsh-vscode-owner`)
      const replacementPath = `${markerPath}.replacement`
      const contents = readFileSync(markerPath, 'utf8')
      writeFileSync(replacementPath, contents, { encoding: 'utf8', flag: 'wx' })
      unlinkSync(markerPath)
      renameSync(replacementPath, markerPath)
    }
    return super.readMarkerSnapshot(directoryPath)
  }
}

class StagedMarkerReplacementStore extends TemporaryWorkspaceOwnershipStore {
  private snapshotCalls = 0

  public constructor(private readonly root: string) {
    super(root)
  }

  protected override async readMarkerSnapshot(directoryPath: string): Promise<
    | {
        readonly contents: string
        readonly identity: { readonly device: string; readonly inode: string }
      }
    | undefined
  > {
    this.snapshotCalls += 1
    if (this.snapshotCalls === 3) {
      const markerPrefix = `.${path.basename(directoryPath)}.dsh-vscode-owner.tmp-`
      const stagedMarker = readdirSync(this.root).find((entry) => entry.startsWith(markerPrefix))
      if (stagedMarker === undefined)
        throw new Error('The temporary marker was not staged before verification.')
      const stagedPath = path.join(this.root, stagedMarker)
      const replacementPath = `${stagedPath}.replacement`
      writeFileSync(replacementPath, 'replacement staging data', { encoding: 'utf8', flag: 'wx' })
      unlinkSync(stagedPath)
      renameSync(replacementPath, stagedPath)
    }
    return super.readMarkerSnapshot(directoryPath)
  }
}

class WorkspaceReplacementAfterOwnershipRead extends TemporaryWorkspaceOwnershipStore {
  private replaced = false

  public constructor(
    root: string,
    private readonly movedDirectory: string,
    private readonly replacementFileName: string,
  ) {
    super(root)
  }

  override async readWithoutLock(directoryPath: string, expectedToken?: string): Promise<string | undefined> {
    const ownershipToken = await super.readWithoutLock(directoryPath, expectedToken)
    if (!this.replaced && ownershipToken !== undefined) {
      this.replaced = true
      renameSync(directoryPath, this.movedDirectory)
      mkdirSync(directoryPath)
      writeFileSync(path.join(directoryPath, this.replacementFileName), 'preserve replaced workspace')
    }
    return ownershipToken
  }
}

class WorkspaceReplacementAtQuarantineMove extends TemporaryWorkspaceOwnershipStore {
  private directoryIdentityCalls = 0
  private replaced = false

  public constructor(
    root: string,
    private readonly targetDirectory: string,
    private readonly movedDirectory: string,
    private readonly replacementFileName: string,
  ) {
    super(root)
  }

  protected override async directoryIdentity(
    directoryPath: string,
  ): Promise<{ readonly device: string; readonly inode: string } | undefined> {
    const identity = await super.directoryIdentity(directoryPath)
    if (directoryPath === this.targetDirectory) {
      this.directoryIdentityCalls += 1
      if (!this.replaced && this.directoryIdentityCalls === 2) {
        this.replaced = true
        renameSync(directoryPath, this.movedDirectory)
        mkdirSync(directoryPath)
        writeFileSync(path.join(directoryPath, this.replacementFileName), 'preserve replaced workspace')
      }
    }
    return identity
  }
}

class MarkerReplacementAfterQuarantineMove extends TemporaryWorkspaceOwnershipStore {
  private replaced = false

  public constructor(
    root: string,
    private readonly sidecarPath: string,
    private readonly movedMarkerPath: string,
  ) {
    super(root)
  }

  protected override async directoryIdentity(
    directoryPath: string,
  ): Promise<{ readonly device: string; readonly inode: string } | undefined> {
    const identity = await super.directoryIdentity(directoryPath)
    if (
      !this.replaced &&
      path.basename(directoryPath) === 'workspace' &&
      path.basename(path.dirname(directoryPath)).startsWith('workspace-cleanup-')
    ) {
      this.replaced = true
      const markerContents = readFileSync(this.sidecarPath, 'utf8')
      renameSync(this.sidecarPath, this.movedMarkerPath)
      writeFileSync(this.sidecarPath, markerContents, { encoding: 'utf8', flag: 'wx' })
    }
    return identity
  }
}

class QuarantineJunctionReplacementStore extends TemporaryWorkspaceOwnershipStore {
  public quarantineJunctionPath: string | undefined

  public constructor(
    root: string,
    private readonly externalDirectory: string,
  ) {
    super(root)
  }

  protected override async directoryIdentity(
    directoryPath: string,
  ): Promise<{ readonly device: string; readonly inode: string } | undefined> {
    const identity = await super.directoryIdentity(directoryPath)
    if (
      this.quarantineJunctionPath === undefined &&
      path.basename(directoryPath).startsWith('workspace-cleanup-')
    ) {
      rmdirSync(directoryPath)
      symlinkSync(this.externalDirectory, directoryPath, process.platform === 'win32' ? 'junction' : 'dir')
      this.quarantineJunctionPath = directoryPath
    }
    return identity
  }
}

class QuarantineParentReplacementBeforeDeleteStore extends TemporaryWorkspaceOwnershipStore {
  public quarantineJunctionPath: string | undefined
  private quarantinedWorkspaceIdentityCalls = 0
  private replaced = false

  public constructor(
    root: string,
    private readonly externalDirectory: string,
    private readonly movedQuarantineDirectory: string,
  ) {
    super(root)
  }

  protected override async directoryIdentity(
    directoryPath: string,
  ): Promise<{ readonly device: string; readonly inode: string } | undefined> {
    const identity = await super.directoryIdentity(directoryPath)
    const quarantineDirectory = path.dirname(directoryPath)
    if (
      !this.replaced &&
      path.basename(directoryPath) === 'workspace' &&
      path.basename(quarantineDirectory).startsWith('workspace-cleanup-')
    ) {
      this.quarantinedWorkspaceIdentityCalls += 1
      if (this.quarantinedWorkspaceIdentityCalls === 2) {
        this.replaced = true
        renameSync(quarantineDirectory, this.movedQuarantineDirectory)
        symlinkSync(
          this.externalDirectory,
          quarantineDirectory,
          process.platform === 'win32' ? 'junction' : 'dir',
        )
        this.quarantineJunctionPath = quarantineDirectory
      }
    }
    return identity
  }
}

function filesystemManager(
  root: string,
  reference: { readonly id: string; readonly path: string; readonly ownershipToken: string },
  store: TemporaryWorkspaceOwnershipStore,
  overrides: {
    readonly createWorkspace?: (
      input: WorkspaceCreateInput,
      signal?: AbortSignal,
    ) => Promise<WorkspaceSummary>
    readonly createOwnershipMarker?: (
      directoryPath: string,
      expectedOwnershipToken?: string,
    ) => Promise<string>
    readonly createDirectoryExclusive?: (directoryPath: string) => Promise<void>
    readonly removeDirectory?: (directoryPath: string) => Promise<void>
    readonly persistReference?: (value: unknown) => Promise<void>
  } = {},
): TemporaryWorkspaceManager {
  return new TemporaryWorkspaceManager({
    rootPath: root,
    initialReference: reference,
    createWorkspace:
      overrides.createWorkspace ??
      ((input) =>
        Promise.resolve({
          id: reference.id,
          name: input.name,
          path: input.path,
          createdAt: '2026-09-26T00:00:00.000Z',
          updatedAt: '2026-09-26T00:00:00.000Z',
          sessionCount: 0,
        })),
    ensureDirectory: async (directoryPath) => {
      await mkdir(directoryPath, { recursive: true })
    },
    createDirectoryExclusive:
      overrides.createDirectoryExclusive ??
      ((directoryPath) => store.createDirectoryExclusive(directoryPath)),
    createTemporaryDirectory: (prefix) => mkdtemp(prefix),
    createOwnershipMarker:
      overrides.createOwnershipMarker ??
      ((directoryPath, expectedToken) => store.create(directoryPath, expectedToken)),
    readOwnershipMarker: (directoryPath, expectedToken) => store.read(directoryPath, expectedToken),
    removeOwnershipMarker: (directoryPath, ownershipToken) => store.remove(directoryPath, ownershipToken),
    removeOwnedDirectory:
      overrides.removeDirectory ??
      ((directoryPath, ownershipToken) => store.removeOwnedDirectory(directoryPath, ownershipToken)),
    isManagedPath: (directoryPath) => isManagedTemporaryWorkspacePath(root, directoryPath),
    isManagedPathMissing: (directoryPath) => isManagedTemporaryWorkspacePathMissing(root, directoryPath),
    samePath: (left, right) => path.resolve(left) === path.resolve(right),
    persistReference: overrides.persistReference ?? (() => Promise.resolve()),
  })
}

describe('TemporaryWorkspaceOwnershipStore', () => {
  it('stores ownership beside a workspace without adding files to workspace content', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)

    const ownershipToken = await store.create(directory)

    expect(ownershipToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(await store.read(directory)).toBe(ownershipToken)
    expect(readdirSync(directory)).toEqual([])
    expect(existsSync(path.join(root, '.workspace-123.dsh-vscode-owner'))).toBe(true)
  })

  it('retains the sidecar token after workspace removal until cleanup completes', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)

    rmSync(directory, { recursive: true })

    expect(await store.read(directory)).toBe(ownershipToken)
    await store.remove(directory, ownershipToken)
    expect(existsSync(path.join(root, '.workspace-123.dsh-vscode-owner'))).toBe(false)
  })

  it('removes the owned workspace through isolated cleanup before removing its sidecar', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'owned.txt'), 'owned workspace data')
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const manager = filesystemManager(root, { id: 'owned-workspace', path: directory, ownershipToken }, store)

    await manager.forget(true)

    expect(existsSync(directory)).toBe(false)
    expect(existsSync(markerPath)).toBe(false)
    expect(readdirSync(root).filter((entry) => entry.startsWith('workspace-cleanup-'))).toEqual([])
  })

  it('does not remove a new workspace or sidecar that replaces the owner after the read', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const originalStore = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await originalStore.create(directory)
    rmSync(directory, { recursive: true })
    const replacementFile = path.join(directory, 'user-data.txt')
    const replacementStore = new TemporaryWorkspaceOwnershipStore(root)
    const readPaused = deferred()
    const resumeRead = deferred()

    class WorkspaceReplacementDuringRead extends TemporaryWorkspaceOwnershipStore {
      private replaced = false

      override async readWithoutLock(
        candidatePath: string,
        expectedToken?: string,
      ): Promise<string | undefined> {
        const found = await super.readWithoutLock(candidatePath, expectedToken)
        if (!this.replaced && found === ownershipToken) {
          this.replaced = true
          readPaused.resolve()
          await resumeRead.promise
        }
        return found
      }
    }

    const racingStore = new WorkspaceReplacementDuringRead(root)
    const removal = racingStore.remove(directory, ownershipToken)
    await readPaused.promise
    mkdirSync(directory)
    writeFileSync(replacementFile, 'preserve replacement data')
    unlinkSync(markerPath)
    const replacementToken = await replacementStore.create(directory)
    resumeRead.resolve()

    await expect(removal).rejects.toThrow('ownership marker changed')

    expect(replacementToken).toBeDefined()
    expect(readFileSync(replacementFile, 'utf8')).toBe('preserve replacement data')
    expect(await replacementStore.read(directory, replacementToken)).toBe(replacementToken)
  })

  it('does not unlink a replaced sidecar even when its marker text is identical', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const replacementPath = path.join(root, '.workspace-123.replacement')
    mkdirSync(directory)
    const ownerStore = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await ownerStore.create(directory)
    const markerContents = readFileSync(markerPath, 'utf8')
    rmSync(directory, { recursive: true })
    const readPaused = deferred()
    const resumeRead = deferred()

    class SidecarReplacementDuringRead extends TemporaryWorkspaceOwnershipStore {
      private replaced = false

      override async readWithoutLock(
        candidatePath: string,
        expectedToken?: string,
      ): Promise<string | undefined> {
        const found = await super.readWithoutLock(candidatePath, expectedToken)
        if (!this.replaced && found === ownershipToken) {
          this.replaced = true
          readPaused.resolve()
          await resumeRead.promise
        }
        return found
      }
    }

    const racingStore = new SidecarReplacementDuringRead(root)
    const removal = racingStore.remove(directory, ownershipToken)
    await readPaused.promise
    writeFileSync(replacementPath, markerContents, { encoding: 'utf8', flag: 'wx' })
    const replacementIdentity = lstatSync(replacementPath, { bigint: true })
    const originalIdentity = lstatSync(markerPath, { bigint: true })
    expect([replacementIdentity.dev.toString(), replacementIdentity.ino.toString()]).not.toEqual([
      originalIdentity.dev.toString(),
      originalIdentity.ino.toString(),
    ])
    unlinkSync(markerPath)
    renameSync(replacementPath, markerPath)
    resumeRead.resolve()

    await expect(removal).rejects.toThrow('ownership marker changed')

    expect(readFileSync(markerPath, 'utf8')).toBe(markerContents)
    expect(await ownerStore.read(directory, ownershipToken)).toBe(ownershipToken)
  })

  it('serializes cleanup before a concurrent workspace restore can rebind the marker', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    rmSync(directory, { recursive: true })
    const readPaused = deferred()
    const resumeRead = deferred()

    class PausedReadStore extends TemporaryWorkspaceOwnershipStore {
      private paused = false

      override async readWithoutLock(
        candidatePath: string,
        expectedToken?: string,
      ): Promise<string | undefined> {
        const found = await super.readWithoutLock(candidatePath, expectedToken)
        if (!this.paused && found === ownershipToken) {
          this.paused = true
          readPaused.resolve()
          await resumeRead.promise
        }
        return found
      }
    }

    const racingStore = new PausedReadStore(root)
    const removal = racingStore.remove(directory, ownershipToken)
    await readPaused.promise
    const restoration = (async () => {
      await racingStore.createDirectoryExclusive(directory)
      return racingStore.create(directory, ownershipToken)
    })()
    expect(existsSync(directory)).toBe(false)
    resumeRead.resolve()

    await expect(removal).resolves.toBeUndefined()
    await expect(restoration).rejects.toThrow('was not verified before restoration')

    expect(existsSync(directory)).toBe(true)
    expect(existsSync(markerPath)).toBe(false)
    expect(await store.read(directory, ownershipToken)).toBeUndefined()
  })

  it('treats missing marker cleanup as complete only after the workspace is also missing', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)

    unlinkSync(markerPath)
    await expect(store.remove(directory, ownershipToken)).rejects.toThrow('ownership marker changed')
    expect(existsSync(directory)).toBe(true)

    await rm(directory, { recursive: true })
    await expect(store.remove(directory, ownershipToken)).resolves.toBeUndefined()
    expect(existsSync(markerPath)).toBe(false)
  })

  it('clears persisted ownership when both the workspace and sidecar vanish before cleanup', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const persistedReferences: unknown[] = []
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      store,
      {
        removeDirectory: async (directoryPath) => {
          await rm(directoryPath, { recursive: true })
          unlinkSync(markerPath)
        },
        persistReference: (reference) => {
          persistedReferences.push(reference)
          return Promise.resolve()
        },
      },
    )

    await expect(manager.forget(true)).resolves.toBeUndefined()

    expect(persistedReferences).toEqual([undefined])
    expect(manager.reference).toBeUndefined()
    expect(existsSync(directory)).toBe(false)
    expect(existsSync(markerPath)).toBe(false)
  })

  it('refuses a mismatched token without changing the marker or workspace', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'user-data.txt'), 'preserve me')
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)

    await expect(store.remove(directory, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toThrow(
      'ownership marker changed',
    )

    expect(await store.read(directory)).toBe(ownershipToken)
    expect(readFileSync(path.join(directory, 'user-data.txt'), 'utf8')).toBe('preserve me')
  })

  it('migrates an old UUID sidecar only when manager state supplies the exact token', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const legacyToken = '11111111-1111-4111-8111-111111111111'
    mkdirSync(directory)
    writeFileSync(markerPath, legacyToken, { encoding: 'utf8', flag: 'wx' })
    const store = new TemporaryWorkspaceOwnershipStore(root)

    expect(await store.read(directory)).toBeUndefined()
    expect(readFileSync(markerPath, 'utf8')).toBe(legacyToken)

    const manager = filesystemManager(
      root,
      {
        id: 'legacy-workspace',
        path: directory,
        ownershipToken: legacyToken,
      },
      store,
    )
    const restored = await manager.resolve([])
    const migratedMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      ownershipToken: string
      device: string
      inode: string
    }
    const directoryStat = lstatSync(directory, { bigint: true })

    expect(restored.path).toBe(directory)
    expect(migratedMarker).toEqual({
      version: 1,
      ownershipToken: legacyToken,
      device: directoryStat.dev.toString(),
      inode: directoryStat.ino.toString(),
    })
    expect(await store.read(directory, legacyToken)).toBe(legacyToken)
  })

  it('rebinds a matching old UUID sidecar after the manager recreates its missing workspace', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const legacyToken = '11111111-1111-4111-8111-111111111111'
    mkdirSync(directory)
    writeFileSync(markerPath, legacyToken, { encoding: 'utf8', flag: 'wx' })
    rmSync(directory, { recursive: true })
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const manager = filesystemManager(
      root,
      { id: 'legacy-workspace', path: directory, ownershipToken: legacyToken },
      store,
    )

    const restored = await manager.resolve([])
    const migratedMarker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
      version: number
      ownershipToken: string
      device: string
      inode: string
    }
    const directoryStat = lstatSync(directory, { bigint: true })

    expect(restored.path).toBe(directory)
    expect(migratedMarker).toEqual({
      version: 1,
      ownershipToken: legacyToken,
      device: directoryStat.dev.toString(),
      inode: directoryStat.ino.toString(),
    })
    expect(await store.read(directory, legacyToken)).toBe(legacyToken)
  })

  it.each([
    ['versioned marker restoration', 'versioned'],
    ['legacy marker migration', 'legacy'],
  ] as const)('preserves a same-content sidecar replacement during %s', async (_label, kind) => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const ownershipToken = '11111111-1111-4111-8111-111111111111'
    mkdirSync(directory)
    const store = new SameContentsMarkerReplacementStore(root)
    let originalContents: string
    let originalIdentity: readonly [string, string]

    if (kind === 'versioned') {
      const originalStore = new TemporaryWorkspaceOwnershipStore(root)
      const originalToken = await originalStore.create(directory)
      originalContents = readFileSync(markerPath, 'utf8')
      const markerBefore = lstatSync(markerPath, { bigint: true })
      originalIdentity = [markerBefore.dev.toString(), markerBefore.ino.toString()]
      rmSync(directory, { recursive: true })
      expect(await store.read(directory, originalToken)).toBe(originalToken)
      await store.createDirectoryExclusive(directory)
      store.armReplacement(3)

      await expect(store.create(directory, originalToken)).rejects.toThrow(
        'changed while its ownership was restored',
      )
    } else {
      writeFileSync(markerPath, ownershipToken, { encoding: 'utf8', flag: 'wx' })
      originalContents = readFileSync(markerPath, 'utf8')
      const markerBefore = lstatSync(markerPath, { bigint: true })
      originalIdentity = [markerBefore.dev.toString(), markerBefore.ino.toString()]
      store.armReplacement(3)

      await expect(store.read(directory, ownershipToken)).resolves.toBeUndefined()
    }

    const markerIdentity = lstatSync(markerPath, { bigint: true })
    expect(readFileSync(markerPath, 'utf8')).toBe(originalContents)
    expect(markerIdentity.isFile()).toBe(true)
    expect([markerIdentity.dev.toString(), markerIdentity.ino.toString()]).not.toEqual(originalIdentity)
    expect(
      readdirSync(root).filter((entry) => entry.endsWith('.replacement') || entry.includes('.tmp-')),
    ).toEqual([])
  })

  it('does not rename or remove a file that replaces the staged marker', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const ownershipToken = '11111111-1111-4111-8111-111111111111'
    mkdirSync(directory)
    writeFileSync(markerPath, ownershipToken, { encoding: 'utf8', flag: 'wx' })
    const originalMarkerIdentity = lstatSync(markerPath, { bigint: true })
    const store = new StagedMarkerReplacementStore(root)

    await expect(store.read(directory, ownershipToken)).resolves.toBeUndefined()

    const stagedMarker = readdirSync(root).find((entry) =>
      entry.startsWith('.workspace-123.dsh-vscode-owner.tmp-'),
    )
    expect(stagedMarker).toBeDefined()
    expect(readFileSync(path.join(root, stagedMarker!), 'utf8')).toBe('replacement staging data')
    const markerAfter = lstatSync(markerPath, { bigint: true })
    expect([markerAfter.dev.toString(), markerAfter.ino.toString()]).toEqual([
      originalMarkerIdentity.dev.toString(),
      originalMarkerIdentity.ino.toString(),
    ])
    expect(readFileSync(markerPath, 'utf8')).toBe(ownershipToken)
  })

  it('does not rebind an old sidecar when another directory wins the missing restore path', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const originalMarker = readFileSync(markerPath, 'utf8')
    rmSync(directory, { recursive: true })
    const replacementFile = path.join(directory, 'replacement-user-data.txt')
    const createWorkspace =
      vi.fn<(input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>>()
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      store,
      {
        createWorkspace,
        createDirectoryExclusive: async (directoryPath) => {
          // Simulate another creator winning between the manager's missing-path
          // check and its exclusive mkdir syscall.
          await mkdir(directoryPath)
          writeFileSync(replacementFile, 'preserve replacement data')
          await mkdir(directoryPath)
        },
      },
    )

    await expect(manager.resolve([])).rejects.toMatchObject({ code: 'EEXIST' })

    expect(createWorkspace).not.toHaveBeenCalled()
    expect(readFileSync(replacementFile, 'utf8')).toBe('preserve replacement data')
    expect(readFileSync(markerPath, 'utf8')).toBe(originalMarker)
    expect(await store.read(directory, ownershipToken)).toBeUndefined()
    expect(manager.reference?.ownershipToken).toBe(ownershipToken)
  })

  it('does not rebind an old sidecar when the exclusively created directory is replaced before marker restoration', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const movedDirectory = path.join(root, 'workspace-123-created')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const originalMarker = readFileSync(markerPath, 'utf8')
    rmSync(directory, { recursive: true })
    const replacementFile = path.join(directory, 'replacement-user-data.txt')
    const createWorkspace =
      vi.fn<(input: WorkspaceCreateInput, signal?: AbortSignal) => Promise<WorkspaceSummary>>()
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      store,
      {
        createWorkspace,
        createDirectoryExclusive: async (directoryPath) => {
          await store.createDirectoryExclusive(directoryPath)
          renameSync(directoryPath, movedDirectory)
          mkdirSync(directoryPath)
          writeFileSync(replacementFile, 'preserve replacement data')
        },
      },
    )

    await expect(manager.resolve([])).rejects.toThrow('changed after exclusive creation')

    expect(createWorkspace).not.toHaveBeenCalled()
    expect(readFileSync(replacementFile, 'utf8')).toBe('preserve replacement data')
    expect(readFileSync(markerPath, 'utf8')).toBe(originalMarker)
    expect(existsSync(movedDirectory)).toBe(true)
    expect(await store.read(directory, ownershipToken)).toBeUndefined()
  })

  it('leaves the exclusively created directory alone when marker restoration fails', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const originalMarker = readFileSync(markerPath, 'utf8')
    rmSync(directory, { recursive: true })
    const removeDirectory = vi.fn<(directoryPath: string) => Promise<void>>()
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      store,
      {
        createOwnershipMarker: () => Promise.reject(new Error('marker storage is unavailable')),
        removeDirectory,
      },
    )

    await expect(manager.resolve([])).rejects.toThrow('marker storage is unavailable')

    expect(removeDirectory).not.toHaveBeenCalled()
    expect(isManagedTemporaryWorkspacePath(root, directory)).toBe(true)
    expect(readFileSync(markerPath, 'utf8')).toBe(originalMarker)
    expect(await store.read(directory, ownershipToken)).toBeUndefined()
  })

  it('does not migrate or delete an old UUID sidecar when persisted token mismatches', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const markerToken = '11111111-1111-4111-8111-111111111111'
    const persistedToken = '22222222-2222-4222-8222-222222222222'
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'keep.txt'), 'user data')
    writeFileSync(markerPath, markerToken, { encoding: 'utf8', flag: 'wx' })
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const manager = filesystemManager(
      root,
      {
        id: 'legacy-workspace',
        path: directory,
        ownershipToken: persistedToken,
      },
      store,
    )

    await manager.forget(true)

    expect(readFileSync(markerPath, 'utf8')).toBe(markerToken)
    expect(readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('user data')
    expect(existsSync(directory)).toBe(true)
  })

  it('does not delete a replacement directory at the same path while retaining its old sidecar', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const movedDirectory = path.join(root, 'workspace-123-original')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'original workspace')
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const originalMarker = readFileSync(markerPath, 'utf8')

    renameSync(directory, movedDirectory)
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'replacement.txt'), 'replacement user data')
    const originalIdentity = lstatSync(movedDirectory, { bigint: true })
    const replacementIdentity = lstatSync(directory, { bigint: true })
    expect([originalIdentity.dev.toString(), originalIdentity.ino.toString()]).not.toEqual([
      replacementIdentity.dev.toString(),
      replacementIdentity.ino.toString(),
    ])

    const manager = filesystemManager(
      root,
      {
        id: 'persisted-workspace',
        path: directory,
        ownershipToken,
      },
      store,
    )
    await manager.forget(true)

    expect(await store.read(directory, ownershipToken)).toBeUndefined()
    await expect(store.remove(directory, ownershipToken)).rejects.toThrow('ownership marker changed')
    expect(readFileSync(markerPath, 'utf8')).toBe(originalMarker)
    expect(readFileSync(path.join(directory, 'replacement.txt'), 'utf8')).toBe('replacement user data')
    expect(readFileSync(path.join(movedDirectory, 'original.txt'), 'utf8')).toBe('original workspace')
  })

  it('keeps malformed partial marker data and its directory untouched', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'user-data.txt'), 'preserve me')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const partialMarker = '11111111-1111-'
    writeFileSync(markerPath, partialMarker, { encoding: 'utf8', flag: 'wx' })
    const store = new TemporaryWorkspaceOwnershipStore(root)

    expect(await store.read(directory)).toBeUndefined()
    await expect(store.remove(directory, '11111111-1111-4111-8111-111111111111')).rejects.toThrow(
      'ownership marker changed',
    )

    expect(readFileSync(markerPath, 'utf8')).toBe(partialMarker)
    expect(readFileSync(path.join(directory, 'user-data.txt'), 'utf8')).toBe('preserve me')
  })

  it('fails closed when a versioned marker contains an unavailable device identity', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const ownershipToken = '11111111-1111-4111-8111-111111111111'
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'user-data.txt'), 'preserve me')
    writeFileSync(markerPath, JSON.stringify({ version: 1, ownershipToken, device: '0', inode: '12345' }), {
      encoding: 'utf8',
      flag: 'wx',
    })
    const store = new TemporaryWorkspaceOwnershipStore(root)

    expect(await store.read(directory, ownershipToken)).toBeUndefined()
    await expect(store.remove(directory, ownershipToken)).rejects.toThrow('ownership marker changed')
    expect(existsSync(directory)).toBe(true)
    expect(readFileSync(path.join(directory, 'user-data.txt'), 'utf8')).toBe('preserve me')
    expect(existsSync(markerPath)).toBe(true)
  })

  it('preserves a replacement workspace that appears after the ownership read before forget cleanup', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const movedDirectory = path.join(root, 'workspace-original')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'original workspace')
    const originalStore = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await originalStore.create(directory)
    const replacementFile = path.join(directory, 'replacement.txt')
    const racingStore = new WorkspaceReplacementAfterOwnershipRead(root, movedDirectory, 'replacement.txt')
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      racingStore,
    )

    await expect(manager.forget(true)).rejects.toThrow('changed before safe removal')

    expect(readFileSync(replacementFile, 'utf8')).toBe('preserve replaced workspace')
    expect(readFileSync(path.join(movedDirectory, 'original.txt'), 'utf8')).toBe('original workspace')
    expect(existsSync(markerPath)).toBe(true)
  })

  it('restores a replacement that races the move into isolated cleanup storage', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const movedDirectory = path.join(root, 'workspace-original')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'original workspace')
    const originalStore = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await originalStore.create(directory)
    const replacementFile = path.join(directory, 'replacement.txt')
    const racingStore = new WorkspaceReplacementAtQuarantineMove(
      root,
      directory,
      movedDirectory,
      'replacement.txt',
    )
    const manager = filesystemManager(
      root,
      { id: 'persisted-workspace', path: directory, ownershipToken },
      racingStore,
    )

    await expect(manager.forget(true)).rejects.toThrow('the replacement was restored')

    expect(readFileSync(replacementFile, 'utf8')).toBe('preserve replaced workspace')
    expect(readFileSync(path.join(movedDirectory, 'original.txt'), 'utf8')).toBe('original workspace')
    expect(existsSync(markerPath)).toBe(true)
    expect(readdirSync(root).filter((entry) => entry.startsWith('workspace-cleanup-'))).toEqual([])
  })

  it('restores workspace data when its sidecar is replaced after the workspace is isolated', async () => {
    const root = temporaryRoot()
    const directory = path.join(root, 'workspace-123')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const movedMarkerPath = path.join(root, '.workspace-123.dsh-vscode-owner-original')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'preserve workspace data')
    const store = new MarkerReplacementAfterQuarantineMove(root, markerPath, movedMarkerPath)
    const ownershipToken = await store.create(directory)
    const markerContents = readFileSync(markerPath, 'utf8')
    const originalMarkerIdentity = lstatSync(markerPath, { bigint: true })

    await expect(store.removeOwnedDirectory(directory, ownershipToken)).rejects.toThrow(
      'ownership marker changed during safe removal; the workspace was restored',
    )

    expect(readFileSync(path.join(directory, 'original.txt'), 'utf8')).toBe('preserve workspace data')
    expect(readFileSync(markerPath, 'utf8')).toBe(markerContents)
    expect(readFileSync(movedMarkerPath, 'utf8')).toBe(markerContents)
    const replacementMarkerIdentity = lstatSync(markerPath, { bigint: true })
    expect([replacementMarkerIdentity.dev.toString(), replacementMarkerIdentity.ino.toString()]).not.toEqual([
      originalMarkerIdentity.dev.toString(),
      originalMarkerIdentity.ino.toString(),
    ])
    expect(readdirSync(root).filter((entry) => entry.startsWith('workspace-cleanup-'))).toEqual([])
  })

  it('does not follow an isolated cleanup path replaced by a directory junction', async () => {
    const sandbox = temporaryRoot()
    const root = path.join(sandbox, 'extension-storage')
    const external = path.join(sandbox, 'user-data')
    mkdirSync(root)
    mkdirSync(external)
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'preserve workspace data')
    const externalFile = path.join(external, 'keep.txt')
    writeFileSync(externalFile, 'preserve external data')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const racingStore = new QuarantineJunctionReplacementStore(root, external)

    await expect(racingStore.removeOwnedDirectory(directory, ownershipToken)).rejects.toThrow(
      'cleanup location could not be verified',
    )

    expect(racingStore.quarantineJunctionPath).toBeDefined()
    expect(lstatSync(racingStore.quarantineJunctionPath!).isSymbolicLink()).toBe(true)
    expect(readFileSync(externalFile, 'utf8')).toBe('preserve external data')
    expect(readFileSync(path.join(directory, 'original.txt'), 'utf8')).toBe('preserve workspace data')
    expect(existsSync(markerPath)).toBe(true)
  })

  it('preserves external data when the isolated cleanup container becomes a junction before deletion', async () => {
    const sandbox = temporaryRoot()
    const root = path.join(sandbox, 'extension-storage')
    const external = path.join(sandbox, 'user-data')
    const movedQuarantineDirectory = path.join(root, 'workspace-cleanup-original')
    mkdirSync(root)
    mkdirSync(external)
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'original.txt'), 'preserve workspace data')
    const externalWorkspace = path.join(external, 'workspace')
    mkdirSync(externalWorkspace)
    const externalFile = path.join(externalWorkspace, 'keep.txt')
    writeFileSync(externalFile, 'preserve external data')
    const markerPath = path.join(root, '.workspace-123.dsh-vscode-owner')
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)
    const racingStore = new QuarantineParentReplacementBeforeDeleteStore(
      root,
      external,
      movedQuarantineDirectory,
    )

    const removalError = await racingStore.removeOwnedDirectory(directory, ownershipToken).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(racingStore.quarantineJunctionPath).toBeDefined()
    expect(existsSync(externalFile)).toBe(true)
    expect(readFileSync(externalFile, 'utf8')).toBe('preserve external data')
    expect(existsSync(racingStore.quarantineJunctionPath ?? '')).toBe(false)
    expect(existsSync(markerPath)).toBe(true)
    expect(removalError).toBeInstanceOf(Error)
    expect(readFileSync(path.join(movedQuarantineDirectory, 'workspace', 'original.txt'), 'utf8')).toBe(
      'preserve workspace data',
    )
  })

  it('does not follow a linked directory nested in the owned workspace during recursive cleanup', async () => {
    const sandbox = temporaryRoot()
    const root = path.join(sandbox, 'extension-storage')
    const external = path.join(sandbox, 'user-data')
    mkdirSync(root)
    mkdirSync(external)
    const directory = path.join(root, 'workspace-123')
    mkdirSync(directory)
    const externalFile = path.join(external, 'keep.txt')
    writeFileSync(externalFile, 'preserve external data')
    symlinkSync(
      external,
      path.join(directory, 'linked-data'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(directory)

    await store.removeOwnedDirectory(directory, ownershipToken)

    expect(existsSync(directory)).toBe(false)
    expect(readFileSync(externalFile, 'utf8')).toBe('preserve external data')
  })

  it('preserves a replacement workspace after failed registration cleanup', async () => {
    const root = temporaryRoot()
    const movedDirectory = path.join(root, 'workspace-original')
    const racingStore = new WorkspaceReplacementAfterOwnershipRead(root, movedDirectory, 'replacement.txt')
    let createdPath: string | undefined
    const manager = filesystemManager(
      root,
      {
        id: 'stale-reference',
        path: path.join(root, 'workspace-missing'),
        ownershipToken: '11111111-1111-4111-8111-111111111111',
      },
      racingStore,
      {
        createWorkspace: (input) => {
          createdPath = input.path
          writeFileSync(path.join(input.path, 'original.txt'), 'original temporary workspace')
          return Promise.reject(new Error('workspace registration failed'))
        },
      },
    )

    await expect(manager.resolve([])).rejects.toThrow('workspace registration failed')

    expect(createdPath).toBeDefined()
    expect(readFileSync(path.join(createdPath!, 'replacement.txt'), 'utf8')).toBe(
      'preserve replaced workspace',
    )
    expect(readFileSync(path.join(movedDirectory, 'original.txt'), 'utf8')).toBe(
      'original temporary workspace',
    )
    const markerPath = path.join(root, `.${path.basename(createdPath!)}.dsh-vscode-owner`)
    expect(existsSync(markerPath)).toBe(true)
  })

  it('rejects a storage root replaced with a real directory junction before any external deletion', async () => {
    const sandbox = temporaryRoot()
    const root = path.join(sandbox, 'extension-storage')
    const movedRoot = path.join(sandbox, 'extension-storage-original')
    const external = path.join(sandbox, 'user-data')
    mkdirSync(root)
    mkdirSync(external)
    const managedDirectory = path.join(root, 'workspace-123')
    mkdirSync(managedDirectory)
    const store = new TemporaryWorkspaceOwnershipStore(root)
    const ownershipToken = await store.create(managedDirectory)

    renameSync(root, movedRoot)
    const externalWorkspace = path.join(external, 'workspace-123')
    mkdirSync(externalWorkspace)
    const externalFile = path.join(externalWorkspace, 'keep.txt')
    writeFileSync(externalFile, 'user data')
    writeFileSync(path.join(external, '.workspace-123.dsh-vscode-owner'), ownershipToken)
    symlinkSync(external, root, process.platform === 'win32' ? 'junction' : 'dir')

    const apparentWorkspace = path.join(root, 'workspace-123')
    expect(isManagedTemporaryWorkspaceLocation(root, apparentWorkspace)).toBe(false)
    expect(isManagedTemporaryWorkspacePath(root, apparentWorkspace)).toBe(false)
    expect(await store.read(apparentWorkspace)).toBeUndefined()
    await expect(store.remove(apparentWorkspace, ownershipToken)).rejects.toThrow('ownership marker changed')

    const manager = new TemporaryWorkspaceManager({
      rootPath: root,
      initialReference: {
        id: 'workspace-123',
        path: apparentWorkspace,
        ownershipToken,
      },
      createWorkspace: () => Promise.reject(new Error('not expected during forget')),
      ensureDirectory: () => Promise.resolve(),
      createDirectoryExclusive: () => Promise.resolve(),
      createTemporaryDirectory: () => Promise.reject(new Error('not expected during forget')),
      createOwnershipMarker: () => Promise.reject(new Error('not expected during forget')),
      readOwnershipMarker: (directoryPath) => store.read(directoryPath),
      removeOwnershipMarker: (directoryPath, token) => store.remove(directoryPath, token),
      removeOwnedDirectory: (directoryPath, ownershipToken) =>
        store.removeOwnedDirectory(directoryPath, ownershipToken),
      isManagedPath: (directoryPath) => isManagedTemporaryWorkspacePath(root, directoryPath),
      isManagedPathMissing: () => false,
      samePath: (left, right) => path.resolve(left) === path.resolve(right),
      persistReference: () => Promise.resolve(),
    })

    await manager.forget(true)

    expect(readFileSync(externalFile, 'utf8')).toBe('user data')
    expect(existsSync(path.join(external, '.workspace-123.dsh-vscode-owner'))).toBe(true)
    expect(existsSync(path.join(movedRoot, 'workspace-123'))).toBe(true)
    expect(existsSync(path.join(movedRoot, '.workspace-123.dsh-vscode-owner'))).toBe(true)
  })
})
