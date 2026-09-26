import { createHash } from 'node:crypto'
import path from 'node:path'

import { CHANGE_LIMITS, CHECKPOINT_LIMITS, type CheckpointCreateInput } from '@dsh-vscode/domain'
import { describe, expect, it } from 'vitest'
import type {
  CheckpointStorage,
  CheckpointStorageEntry,
  CheckpointWorkspaceAccess,
} from './checkpoint-store.js'
import { CheckpointStore } from './checkpoint-store.js'

class MemoryStorage implements CheckpointStorage {
  readonly files = new Map<string, Uint8Array>()
  readonly directories = new Set<string>()
  failRenames = 0
  failRenameDestination: string | undefined
  failDeletePath: string | undefined
  afterRename: ((destinationPath: string) => void) | undefined

  public mkdir(directory: string): Promise<void> {
    this.directories.add(this.normalize(directory))
    return Promise.resolve()
  }

  public list(directory: string): Promise<readonly CheckpointStorageEntry[]> {
    const parent = this.normalize(directory)
    const prefix = `${parent}${path.sep}`
    const entries = new Map<string, CheckpointStorageEntry['kind']>()
    for (const candidate of this.directories) {
      if (!candidate.startsWith(prefix)) continue
      const remainder = candidate.slice(prefix.length)
      if (remainder !== '' && !remainder.includes(path.sep)) entries.set(remainder, 'directory')
    }
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue
      const remainder = candidate.slice(prefix.length)
      if (remainder !== '' && !remainder.includes(path.sep) && !entries.has(remainder))
        entries.set(remainder, 'file')
    }
    return Promise.resolve([...entries].map(([name, kind]) => ({ name, kind })))
  }

  public readFile(filePath: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(this.normalize(filePath))
    return Promise.resolve(bytes === undefined ? undefined : new Uint8Array(bytes))
  }

  public writeFile(filePath: string, data: Uint8Array): Promise<void> {
    this.files.set(this.normalize(filePath), new Uint8Array(data))
    return Promise.resolve()
  }

  public rename(sourcePath: string, destinationPath: string, overwrite: boolean): Promise<void> {
    const source = this.normalize(sourcePath)
    const destination = this.normalize(destinationPath)
    if (this.failRenames > 0) {
      this.failRenames -= 1
      throw new Error('injected storage rename failure')
    }
    if (this.failRenameDestination === destination) {
      this.failRenameDestination = undefined
      throw new Error('injected storage rename failure for destination')
    }
    const bytes = this.files.get(source)
    if (bytes === undefined) throw new Error('missing source storage file')
    if (!overwrite && this.files.has(destination)) throw new Error('destination already exists')
    this.files.delete(source)
    this.files.set(destination, bytes)
    this.afterRename?.(destination)
    return Promise.resolve()
  }

  public delete(filePath: string, recursive: boolean): Promise<void> {
    const target = this.normalize(filePath)
    if (target === this.failDeletePath) throw new Error('injected storage delete failure')
    if (recursive) {
      const prefix = `${target}${path.sep}`
      for (const candidate of [...this.files.keys()])
        if (candidate === target || candidate.startsWith(prefix)) this.files.delete(candidate)
      for (const candidate of [...this.directories])
        if (candidate === target || candidate.startsWith(prefix)) this.directories.delete(candidate)
      return Promise.resolve()
    }
    this.files.delete(target)
    return Promise.resolve()
  }

  private normalize(value: string): string {
    return path.normalize(value)
  }
}

class MemoryWorkspace implements CheckpointWorkspaceAccess {
  readonly files = new Map<string, Uint8Array>()
  readonly mutations: string[] = []
  /** Destination paths of the renames that reached the workspace, in order. */
  readonly renames: string[] = []
  failRenames = 0
  afterRename: (() => void) | undefined
  readGate:
    { readonly relativePath: string; readonly wait: Promise<void>; readonly onWait: () => void } | undefined

  public async readFile(_workspaceFolderId: string, relativePath: string): Promise<Uint8Array | undefined> {
    const gate = this.readGate
    if (gate?.relativePath === relativePath) {
      this.readGate = undefined
      gate.onWait()
      await gate.wait
    }
    const bytes = this.files.get(relativePath)
    return bytes === undefined ? undefined : new Uint8Array(bytes)
  }

  public writeFile(_workspaceFolderId: string, relativePath: string, data: Uint8Array): Promise<void> {
    this.files.set(relativePath, new Uint8Array(data))
    this.mutations.push(`write:${relativePath}`)
    return Promise.resolve()
  }

  public deleteFile(_workspaceFolderId: string, relativePath: string): Promise<void> {
    this.files.delete(relativePath)
    this.mutations.push(`delete:${relativePath}`)
    return Promise.resolve()
  }

  public renameFile(
    _workspaceFolderId: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
    overwrite: boolean,
  ): Promise<void> {
    if (this.failRenames > 0) {
      this.failRenames -= 1
      throw new Error('injected workspace rename failure')
    }
    const bytes = this.files.get(sourceRelativePath)
    if (bytes === undefined) throw new Error('missing source workspace file')
    if (!overwrite && this.files.has(destinationRelativePath)) throw new Error('destination already exists')
    this.files.delete(sourceRelativePath)
    this.files.set(destinationRelativePath, bytes)
    this.renames.push(destinationRelativePath)
    this.mutations.push(`rename:${sourceRelativePath}:${destinationRelativePath}`)
    this.afterRename?.()
    return Promise.resolve()
  }
}

function createStore(
  storage: MemoryStorage,
  workspace: MemoryWorkspace,
  contentEnabled: boolean,
  onStorageIssue?: (issue: { readonly directory: string; readonly phase: 'journal' | 'manifest' }) => void,
  workspaceTrusted: boolean | (() => boolean) = true,
): CheckpointStore {
  let sequence = 0
  return new CheckpointStore({
    rootPath: 'checkpoint-root',
    storage,
    workspace,
    enabled: () => true,
    contentEnabled: () => contentEnabled,
    workspaceTrusted: typeof workspaceTrusted === 'function' ? workspaceTrusted : () => workspaceTrusted,
    now: () => 1_000 + sequence,
    makeId: () => `id-${++sequence}`,
    ...(onStorageIssue === undefined ? {} : { onStorageIssue }),
  })
}

async function restoreWithPreview(
  store: CheckpointStore,
  checkpointId: string,
  expectedRevision: number,
  conflictPolicy: 'abort' | 'overwrite',
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<CheckpointStore['restore']>>> {
  const preview = await store.preview(checkpointId)
  return store.restore(checkpointId, expectedRevision, preview.previewId, conflictPolicy, signal)
}

/**
 * A create request naming the paths a session changed. The store reads each
 * file itself: a change row states a diff, and no diff is the file.
 */
function changeInput(...relativePaths: readonly string[]): CheckpointCreateInput {
  return {
    sessionId: 'session-1',
    workspaceFolderId: 'workspace-1',
    sourceChangeSetId: 'change-set-1',
    files: (relativePaths.length === 0 ? ['src/main.ts'] : relativePaths).map((relativePath) => ({
      relativePath,
    })),
  }
}

function checkpointDirectory(rootPath: string, checkpointId: string): string {
  const digest = createHash('sha256').update(checkpointId, 'utf8').digest('hex').slice(0, 32)
  return path.join(rootPath, `checkpoint-${digest}`)
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function persisted<T>(payload: T): Uint8Array {
  const checksum = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
  return Buffer.from(JSON.stringify({ version: 1, payload, checksum }), 'utf8')
}

interface PersistedManifest {
  readonly files: Array<{ readonly relativePath: string; readonly presentAtCheckpoint: boolean }>
}

async function readManifest(storage: CheckpointStorage, checkpointId: string): Promise<PersistedManifest> {
  const bytes = await storage.readFile(
    path.join(checkpointDirectory('checkpoint-root', checkpointId), 'manifest.json'),
  )
  const envelope = JSON.parse(Buffer.from(bytes ?? []).toString('utf8')) as {
    payload: PersistedManifest
  }
  return envelope.payload
}

describe('CheckpointStore', () => {
  it('is disabled by default and does not read or mutate workspace files', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = new CheckpointStore({
      rootPath: 'checkpoint-root',
      storage,
      workspace,
      workspaceTrusted: () => true,
    })

    await expect(store.create(changeInput())).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect(await store.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
  })

  it('creates metadata-only checkpoints and never presents them as restorable', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, false)

    const summary = await store.create(changeInput())
    expect(summary).toMatchObject({
      state: 'metadata-only',
      contentEnabled: false,
      restoreAllowed: false,
      fileCount: 1,
    })
    expect([...storage.files.keys()].some((file) => file.endsWith('content-0.bin'))).toBe(false)
    await expect(store.restore(summary.checkpointId, 1, 'dsh-preview-unused', 'abort')).rejects.toMatchObject(
      {
        code: 'CAPABILITY_UNAVAILABLE',
      },
    )
    expect(await store.list({ workspaceFolderId: 'workspace-1', sessionId: 'session-1' })).toHaveLength(1)
  })

  it('stores the file as it is at creation instead of a change fragment', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    // The file a session edited. A change row states one hunk of the edit — the
    // model's anchor, context-widened or decomposed — so reading that text as
    // the file wrote a fragment over the user's file on restore.
    const wholeFile = 'const a = 1\nconst b = 2\nconst c = 3\n'
    workspace.files.set('src/main.ts', Buffer.from(wholeFile))
    const store = createStore(storage, workspace, true)

    const summary = await store.create(changeInput('src/main.ts'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)

    expect(summary).toMatchObject({ state: 'content-ready', restoreAllowed: true, fileCount: 1 })
    expect(
      Buffer.from((await storage.readFile(path.join(directory, 'content-0.bin'))) ?? []).toString(),
    ).toBe(wholeFile)
    const restored = await restoreWithPreview(
      store,
      summary.checkpointId,
      summary.expectedRevision ?? 0,
      'abort',
    )
    expect(restored).toMatchObject({ state: 'completed', restoredPaths: ['src/main.ts'] })
    expect(workspace.renames).toEqual(['src/main.ts'])
  })

  it('records a path the session removed as absent and restores what is still there', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/kept.ts', Buffer.from('kept\n'))
    // `src/removed.ts` is a change row whose file is already gone: the snapshot
    // records the absence, so a restore removes it rather than writing a
    // fragment of the deletion diff.
    const store = createStore(storage, workspace, true)

    const summary = await store.create(changeInput('src/kept.ts', 'src/removed.ts'))
    expect(summary).toMatchObject({ state: 'content-ready', fileCount: 2 })
    const manifest = await readManifest(storage, summary.checkpointId)

    expect(
      manifest.files.map((file) => ({
        relativePath: file.relativePath,
        presentAtCheckpoint: file.presentAtCheckpoint,
      })),
    ).toEqual([
      { relativePath: 'src/kept.ts', presentAtCheckpoint: true },
      { relativePath: 'src/removed.ts', presentAtCheckpoint: false },
    ])
    await workspace.writeFile('workspace-1', 'src/kept.ts', Buffer.from('rewritten\n'))
    await expect(
      restoreWithPreview(store, summary.checkpointId, summary.expectedRevision ?? 0, 'abort'),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_CONFLICT' })
    expect(Buffer.from(workspace.files.get('src/kept.ts') ?? []).toString()).toBe('rewritten\n')
  })

  it('marks a checkpoint stale and preserves external edits when conflict policy aborts', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('external'))

    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'CHECKPOINT_CONFLICT',
    })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('external')
    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('rolls back the original workspace bytes after an apply failure', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    workspace.failRenames = 1

    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
  })

  it('marks content as corrupt when the stored bytes fail their checksum', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await storage.writeFile(path.join(directory, 'content-0.bin'), Buffer.from('tampered'))

    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })
    expect((await store.get(summary.checkpointId)).state).toBe('corrupt')
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
  })

  it('reports a checkpoint whose manifest cannot be trusted instead of dropping it silently', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    // A readable envelope with a payload this version cannot use: the checkpoint
    // is unusable, but hiding it also hides that the stored bytes are stranded.
    await storage.writeFile(
      path.join(directory, 'manifest.json'),
      persisted({ checkpointId: created.checkpointId, files: 'not-an-array' }),
    )
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await recovered.initialize()

    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    const expectedDirectory = path.normalize(directory)
    expect(issues).toEqual([{ directory: expectedDirectory, phase: 'manifest' }])
  })

  it('reports a manifest that fails its integrity check', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    await storage.writeFile(path.join(directory, 'manifest.json'), Buffer.from('{"version":1,"payload":{}}'))
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await recovered.initialize()

    expect(issues).toEqual([{ directory: path.normalize(directory), phase: 'manifest' }])
  })

  it('reports an unreadable journal so a skipped crash recovery cannot stay invisible', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    await storage.writeFile(path.join(directory, 'journal.json'), Buffer.from('{"version":1,"payload"'))
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await recovered.initialize()

    // The manifest cannot be used without knowing whether an interrupted
    // applying journal still needs rollback.
    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    await expect(recovered.get(created.checkpointId)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(issues).toEqual([{ directory: path.normalize(directory), phase: 'journal' }])
  })

  it('keeps a checkpoint unavailable when an applying journal fails its checksum', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    const backup = Buffer.from('before')
    await storage.writeFile(path.join(directory, 'backup-0.bin'), backup)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially applied'))
    const journalPayload = {
      operationId: 'checksum-crash',
      checkpointId: created.checkpointId,
      state: 'applying',
      entries: [
        {
          relativePath: 'src/main.ts',
          backupRef: 'backup-0.bin',
          tempPath: 'src/main.ts.dsh-vscode-tmp-checksum-crash',
          originalPresent: true,
        },
      ],
      appliedPaths: ['src/main.ts'],
      conflictPaths: [],
    }
    const envelope = JSON.parse(Buffer.from(persisted(journalPayload)).toString('utf8')) as {
      payload: { appliedPaths: string[] }
    }
    envelope.payload.appliedPaths.push('src/other.ts')
    await storage.writeFile(path.join(directory, 'journal.json'), Buffer.from(JSON.stringify(envelope)))
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await recovered.initialize()

    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    await expect(recovered.get(created.checkpointId)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    await expect(restoreWithPreview(recovered, created.checkpointId, 1, 'overwrite')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('partially applied')
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(true)
    expect(issues).toEqual([{ directory: path.normalize(directory), phase: 'journal' }])
  })

  it('reports a checksummed journal with an invalid applying shape and skips its manifest', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially applied'))
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'shape-crash',
        checkpointId: created.checkpointId,
        state: 'applying',
        entries: 'not-an-array',
        appliedPaths: ['src/main.ts'],
        conflictPaths: [],
      }),
    )
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await expect(recovered.initialize()).resolves.toBeUndefined()

    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('partially applied')
    expect(issues).toEqual([{ directory: path.normalize(directory), phase: 'journal' }])
  })

  it('does not treat an applying journal with no applied paths as a completed rollback', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    const first = createStore(storage, workspace, true)
    const created = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', created.checkpointId)
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('before'))
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially applied'))
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'empty-apply-crash',
        checkpointId: created.checkpointId,
        state: 'applying',
        entries: [
          {
            relativePath: 'src/main.ts',
            backupRef: 'backup-0.bin',
            tempPath: 'src/main.ts.dsh-vscode-tmp-empty-apply-crash',
            originalPresent: true,
          },
        ],
        appliedPaths: [],
        conflictPaths: [],
      }),
    )
    const issues: Array<{ readonly directory: string; readonly phase: string }> = []
    const recovered = createStore(storage, workspace, true, (issue) => issues.push(issue))

    await recovered.initialize()

    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('partially applied')
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(true)
    expect(issues).toEqual([{ directory: path.normalize(directory), phase: 'journal' }])
  })

  it('recovers a journaled in-progress restore on the next initialization', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially-written'))
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('new'))
    const tempPath = 'src/main.ts.dsh-vscode-tmp-crash-1'
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'crash-1',
        checkpointId: summary.checkpointId,
        state: 'applying',
        entries: [
          { relativePath: 'src/main.ts', backupRef: 'backup-0.bin', tempPath, originalPresent: true },
        ],
        appliedPaths: ['src/main.ts'],
        conflictPaths: [],
      }),
    )

    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
    expect(await recovered.get(summary.checkpointId)).toMatchObject({ state: 'content-ready' })
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(false)
  })

  it('cleans a crashed preparing journal without touching any workspace path', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('edited after crash'))
    const tempPath = 'src/main.ts.dsh-vscode-tmp-crashed-preparation'
    await workspace.writeFile('workspace-1', tempPath, Buffer.from('preexisting workspace file'))
    const mutationsBeforeRecovery = [...workspace.mutations]
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('edited after crash'))
    await storage.writeFile(path.join(directory, 'backup-0.bin.tmp-crash'), Buffer.from('partial'))
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'crashed-preparation',
        checkpointId: summary.checkpointId,
        state: 'preparing',
        entries: [
          {
            relativePath: 'src/main.ts',
            backupRef: 'backup-0.bin',
            tempPath,
            originalPresent: true,
          },
        ],
        appliedPaths: [],
        conflictPaths: [],
      }),
    )
    await storage.writeFile(path.join(directory, 'journal.json.tmp-crash'), Buffer.from('partial'))

    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()

    expect(workspace.mutations).toEqual(mutationsBeforeRecovery)
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('edited after crash')
    expect(Buffer.from(workspace.files.get(tempPath) ?? []).toString()).toBe('preexisting workspace file')
    expect(
      [...storage.files.keys()]
        .filter((filePath) => path.dirname(filePath) === path.normalize(directory))
        .sort(),
    ).toEqual([path.join(directory, 'content-0.bin'), path.join(directory, 'manifest.json')].sort())
  })

  it('does not run startup recovery while the workspace is untrusted', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially-written'))
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('before'))
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'untrusted-crash',
        checkpointId: summary.checkpointId,
        state: 'applying',
        entries: [
          {
            relativePath: 'src/main.ts',
            backupRef: 'backup-0.bin',
            tempPath: 'src/main.ts.dsh-vscode-tmp-untrusted-crash',
            originalPresent: true,
          },
        ],
        appliedPaths: ['src/main.ts'],
        conflictPaths: [],
      }),
    )

    const untrusted = createStore(storage, workspace, true, undefined, false)
    await expect(untrusted.list({ workspaceFolderId: 'workspace-1' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })

    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('partially-written')
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(true)
  })

  it('rechecks workspace trust before restoring after initialization', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('before'))
    let trusted = true
    const store = createStore(storage, workspace, true, undefined, () => trusted)
    const summary = await store.create(changeInput())
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('changed'))
    const preview = await store.preview(summary.checkpointId)
    trusted = false

    await expect(
      store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite'),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('changed')
    expect(workspace.renames).toEqual([])
  })

  it('leaves the workspace file alone when the interrupted restore lost its backup', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('partially-written'))
    // The crash also lost `backup-0.bin`. Rolling back with an undefined payload
    // would blank the file, which is worse than leaving the partial content in
    // place and keeping the journal for a later repair.
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'crash-2',
        checkpointId: summary.checkpointId,
        state: 'applying',
        entries: [
          {
            relativePath: 'src/main.ts',
            backupRef: 'backup-0.bin',
            tempPath: 'src/main.ts.dsh-vscode-tmp-crash-2',
            originalPresent: true,
          },
        ],
        appliedPaths: ['src/main.ts'],
        conflictPaths: [],
      }),
    )

    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('partially-written')
    expect(await recovered.get(summary.checkpointId)).toMatchObject({ state: 'partial-restore' })
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(true)
  })

  it('rolls back already-restored files when cancellation arrives mid-transaction', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const controller = new AbortController()
    let renameCount = 0
    workspace.afterRename = () => {
      renameCount += 1
      if (renameCount === 1) controller.abort()
    }

    await expect(
      restoreWithPreview(store, summary.checkpointId, 1, 'abort', controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')).resolves.toMatchObject({
      state: 'completed',
    })
  })

  it('cleans completed backups when storage fails partway through preparation', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    storage.failRenameDestination = path.join(directory, 'backup-1.bin')

    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })

    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
    expect(
      [...storage.files.keys()].some((filePath) =>
        /(?:backup-\d+\.bin(?:\.tmp-.+)?|journal\.json(?:\.tmp-.+)?$)/u.test(path.basename(filePath)),
      ),
    ).toBe(false)
  })

  it('keeps an incomplete preparation journal and blocks retries until startup cleanup succeeds', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    storage.failRenameDestination = path.join(directory, 'backup-1.bin')
    storage.failDeletePath = path.join(directory, 'backup-0.bin')

    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(true)
    await expect(restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')

    storage.failDeletePath = undefined
    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(false)
    expect(storage.files.has(path.join(directory, 'backup-0.bin'))).toBe(false)
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
  })

  it('cleans preparation artifacts when cancellation arrives between backup writes', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    const controller = new AbortController()
    storage.afterRename = (destinationPath) => {
      if (destinationPath === path.join(directory, 'backup-0.bin')) controller.abort()
    }

    await expect(
      restoreWithPreview(store, summary.checkpointId, 1, 'overwrite', controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })

    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
    expect(
      [...storage.files.keys()].some((filePath) =>
        /^(?:backup-\d+\.bin|journal\.json)/u.test(path.basename(filePath)),
      ),
    ).toBe(false)
  })

  it('rejects a concurrent restore for the same checkpoint during its read preflight', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    const firstPreview = await store.preview(summary.checkpointId)
    const secondPreview = await store.preview(summary.checkpointId)
    const readStarted = deferred()
    const readRelease = deferred()
    workspace.readGate = {
      relativePath: 'src/main.ts',
      wait: readRelease.promise,
      onWait: readStarted.resolve,
    }

    const firstRestore = store.restore(summary.checkpointId, 1, firstPreview.previewId, 'overwrite')
    await readStarted.promise
    await expect(
      store.restore(summary.checkpointId, 1, secondPreview.previewId, 'overwrite'),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_CONFLICT' })
    readRelease.resolve()
    await expect(firstRestore).resolves.toMatchObject({ state: 'completed' })
  })

  it('does not let checkpoint deletion remove backups during an active restore', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const preview = await store.preview(summary.checkpointId)
    const renameStarted = deferred()
    const renameRelease = deferred()
    const renameFile = workspace.renameFile.bind(workspace)
    let pauseNextRename = true
    workspace.renameFile = async (workspaceFolderId, sourcePath, destinationPath, overwrite) => {
      if (pauseNextRename && destinationPath === 'src/two.ts') {
        pauseNextRename = false
        renameStarted.resolve()
        await renameRelease.promise
      }
      await renameFile(workspaceFolderId, sourcePath, destinationPath, overwrite)
    }

    const restore = store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite')
    await renameStarted.promise
    workspace.failRenames = 1
    const deletion = await store.delete(summary.checkpointId).then(
      () => ({ succeeded: true as const }),
      (error: unknown) => ({ succeeded: false as const, error }),
    )
    renameRelease.resolve()
    await expect(restore).rejects.toBeDefined()

    expect(deletion).toMatchObject({
      succeeded: false,
      error: { code: 'CHECKPOINT_CONFLICT' },
    })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
    await expect(store.get(summary.checkpointId)).resolves.toMatchObject({ state: 'content-ready' })
    await expect(
      store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite'),
    ).resolves.toMatchObject({ state: 'completed' })
    await expect(store.delete(summary.checkpointId)).resolves.toBeUndefined()
    await expect(store.get(summary.checkpointId)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('preserves a partial restore journal and backups until startup recovery succeeds', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('checkpoint-one'))
    workspace.files.set('src/two.ts', Buffer.from('checkpoint-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await workspace.writeFile('workspace-1', 'src/one.ts', Buffer.from('external-one'))
    await workspace.writeFile('workspace-1', 'src/two.ts', Buffer.from('external-two'))
    const preview = await store.preview(summary.checkpointId)
    const renameFile = workspace.renameFile.bind(workspace)
    let appliedFirstFile = false
    let failedSecondApply = false
    workspace.renameFile = async (workspaceFolderId, sourcePath, destinationPath, overwrite) => {
      if (destinationPath === 'src/one.ts') {
        if (appliedFirstFile) throw new Error('injected rollback failure')
        appliedFirstFile = true
      } else if (destinationPath === 'src/two.ts' && !failedSecondApply) {
        failedSecondApply = true
        throw new Error('injected apply failure')
      }
      await renameFile(workspaceFolderId, sourcePath, destinationPath, overwrite)
    }

    await expect(
      store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite'),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_PARTIAL' })

    const journalPath = path.join(directory, 'journal.json')
    expect(await storage.readFile(journalPath)).toBeDefined()
    expect(await storage.readFile(path.join(directory, 'backup-0.bin'))).toBeDefined()
    expect(await storage.readFile(path.join(directory, 'backup-1.bin'))).toBeDefined()
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('checkpoint-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('external-two')
    await expect(store.delete(summary.checkpointId)).rejects.toMatchObject({ code: 'CHECKPOINT_CONFLICT' })
    const applyingJournalBytes = await storage.readFile(journalPath)
    expect(applyingJournalBytes).toBeDefined()
    if (applyingJournalBytes === undefined) throw new Error('The incomplete journal fixture is missing.')
    const applyingJournal = JSON.parse(Buffer.from(applyingJournalBytes).toString('utf8')) as {
      readonly payload: Record<string, unknown>
    }
    await storage.writeFile(journalPath, Buffer.from('invalid journal'))
    await expect(store.delete(summary.checkpointId)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
    expect(await storage.readFile(path.join(directory, 'backup-0.bin'))).toBeDefined()
    await storage.writeFile(
      journalPath,
      persisted({ ...applyingJournal.payload, checkpointId: 'another-checkpoint' }),
    )
    await expect(store.delete(summary.checkpointId)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' })
    expect(await storage.readFile(path.join(directory, 'backup-0.bin'))).toBeDefined()
    await storage.writeFile(journalPath, applyingJournalBytes)

    workspace.renameFile = renameFile
    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('external-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('external-two')
    expect(await storage.readFile(journalPath)).toBeUndefined()
    await expect(recovered.get(summary.checkpointId)).resolves.toMatchObject({ state: 'partial-restore' })
    await storage.writeFile(journalPath, persisted({ ...applyingJournal.payload, state: 'rolled-back' }))
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('orphaned settled backup'))
    await expect(recovered.delete(summary.checkpointId)).resolves.toBeUndefined()
    expect(await storage.readFile(path.join(directory, 'backup-0.bin'))).toBeUndefined()
  })

  it('does not let a restore start while checkpoint deletion is in progress', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('at-checkpoint'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    await workspace.writeFile('workspace-1', 'src/main.ts', Buffer.from('external edit'))
    const preview = await store.preview(summary.checkpointId)
    const deletionStarted = deferred()
    const deletionRelease = deferred()
    const deletePath = storage.delete.bind(storage)
    storage.delete = async (filePath, recursive) => {
      if (recursive) {
        deletionStarted.resolve()
        await deletionRelease.promise
      }
      await deletePath(filePath, recursive)
    }

    const deletion = store.delete(summary.checkpointId)
    await deletionStarted.promise
    const restoration = await store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite').then(
      () => ({ succeeded: true as const }),
      (error: unknown) => ({ succeeded: false as const, error }),
    )
    deletionRelease.resolve()
    await deletion

    expect(restoration).toMatchObject({
      succeeded: false,
      error: { code: 'CHECKPOINT_CONFLICT' },
    })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('external edit')
  })

  it('releases the checkpoint operation lock when deletion fails so deletion can be retried', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('current'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    storage.failDeletePath = directory

    await expect(store.delete(summary.checkpointId)).rejects.toThrow('injected storage delete failure')

    storage.failDeletePath = undefined
    await expect(store.delete(summary.checkpointId)).resolves.toBeUndefined()
    await expect(store.get(summary.checkpointId)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })

  it('puts back a changed file, recreates a deleted one and removes one added since', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('one\n'))
    workspace.files.set('src/two.ts', Buffer.from('two\n'))
    const store = createStore(storage, workspace, true)
    // `src/removed.ts` was gone when the checkpoint was taken, so the snapshot
    // holds no content for it and a restore removes it again.
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts', 'src/removed.ts'))
    await workspace.writeFile('workspace-1', 'src/one.ts', Buffer.from('edited\n'))
    await workspace.deleteFile('workspace-1', 'src/two.ts')
    await workspace.writeFile('workspace-1', 'src/removed.ts', Buffer.from('added later\n'))

    const restored = await restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')

    expect(restored).toMatchObject({
      state: 'completed',
      restoredPaths: ['src/one.ts', 'src/two.ts', 'src/removed.ts'],
    })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('one\n')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('two\n')
    expect(workspace.files.has('src/removed.ts')).toBe(false)
    expect((await store.get(summary.checkpointId)).state).toBe('content-ready')
  })

  it('refuses overwrite when a file changes after the confirmed preview', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('one at checkpoint'))
    workspace.files.set('src/two.ts', Buffer.from('two at checkpoint'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts', 'src/removed.ts'))
    await workspace.writeFile('workspace-1', 'src/one.ts', Buffer.from('one before preview'))
    const preview = await store.preview(summary.checkpointId)
    expect(preview.conflictCount).toBe(1)

    // This second edit did not appear in the dialog. A global overwrite choice
    // for `src/one.ts` must not authorize the later edit or deletion of the
    // other two paths.
    await workspace.writeFile('workspace-1', 'src/two.ts', Buffer.from('two after preview'))
    await workspace.writeFile('workspace-1', 'src/removed.ts', Buffer.from('added after preview'))

    await expect(
      store.restore(summary.checkpointId, 1, preview.previewId, 'overwrite'),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_CONFLICT' })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('one before preview')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('two after preview')
    expect(Buffer.from(workspace.files.get('src/removed.ts') ?? []).toString()).toBe('added after preview')
    expect(workspace.renames).toEqual([])
  })

  it('reclaims journal and backup storage after a restore that replaced changed files', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    await workspace.writeFile('workspace-1', 'src/two.ts', Buffer.from('external'))

    await restoreWithPreview(store, summary.checkpointId, 1, 'overwrite')

    // The backups the restore wrote before touching the workspace are per-file
    // copies of the pre-restore bytes: nothing can read them again once the
    // restore committed, and the quota accounting only sees manifest.totalBytes,
    // so keeping them would consume storage forever.
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    const leftover = Array.from(storage.files.keys()).filter((file) => file.startsWith(`${directory}`))
    expect(leftover.filter((file) => file.endsWith('journal.json'))).toEqual([])
    expect(leftover.filter((file) => /backup-\d+\.bin$/u.test(file))).toEqual([])
  })

  it('reclaims a terminal journal a crash left behind and records what it proves', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput())
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    // The crash landed after the partial restore recorded its terminal journal
    // but before the manifest write and the cleanup. The journal proves the
    // restore already ran, so the manifest must not keep offering it while the
    // journal, its backup and a leftover temp file occupy storage forever.
    const tempPath = 'src/main.ts.dsh-vscode-tmp-crash-3'
    await workspace.writeFile('workspace-1', tempPath, Buffer.from('leftover'))
    await storage.writeFile(path.join(directory, 'backup-0.bin'), Buffer.from('new'))
    await storage.writeFile(
      path.join(directory, 'journal.json'),
      persisted({
        operationId: 'crash-3',
        checkpointId: summary.checkpointId,
        state: 'partial-restore',
        entries: [
          { relativePath: 'src/main.ts', backupRef: 'backup-0.bin', tempPath, originalPresent: true },
        ],
        appliedPaths: ['src/main.ts'],
        conflictPaths: [],
      }),
    )

    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()

    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(false)
    expect(storage.files.has(path.join(directory, 'backup-0.bin'))).toBe(false)
    expect(workspace.files.has(tempPath)).toBe(false)
    expect(await recovered.get(summary.checkpointId)).toMatchObject({
      state: 'partial-restore',
      restoreAllowed: false,
    })
  })

  it('rejects invalid paths and file-count quota before reading workspace bytes', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    const store = createStore(storage, workspace, true)
    await expect(store.create(changeInput('src/main.ts:secret'))).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    const files = Array.from({ length: CHECKPOINT_LIMITS.maxFiles + 1 }, (_, index) => ({
      relativePath: `src/file-${index}.ts`,
    }))
    await expect(
      store.create({ sessionId: 'session-1', workspaceFolderId: 'workspace-1', files }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_QUOTA' })
  })

  it('accepts every change row a session can still hold', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    const paths = Array.from({ length: CHANGE_LIMITS.maxFiles }, (_, index) => `src/file-${index}.ts`)
    for (const relativePath of paths) workspace.files.set(relativePath, Buffer.from('new'))
    const store = createStore(storage, workspace, true)

    const summary = await store.create({
      sessionId: 'session-1',
      workspaceFolderId: 'workspace-1',
      files: paths.map((relativePath) => ({ relativePath })),
    })

    expect(summary).toMatchObject({
      fileCount: CHANGE_LIMITS.maxFiles,
      state: 'content-ready',
      restoreAllowed: true,
    })
  })

  it('honors cancellation before checkpoint work begins', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const controller = new AbortController()
    controller.abort()

    await expect(store.create(changeInput(), controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
  })
})
