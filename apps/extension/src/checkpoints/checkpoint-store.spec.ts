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
    if (this.failRenames > 0) {
      this.failRenames -= 1
      throw new Error('injected storage rename failure')
    }
    const source = this.normalize(sourcePath)
    const destination = this.normalize(destinationPath)
    const bytes = this.files.get(source)
    if (bytes === undefined) throw new Error('missing source storage file')
    if (!overwrite && this.files.has(destination)) throw new Error('destination already exists')
    this.files.delete(source)
    this.files.set(destination, bytes)
    return Promise.resolve()
  }

  public delete(filePath: string, recursive: boolean): Promise<void> {
    const target = this.normalize(filePath)
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
  /** Destination paths of the renames that reached the workspace, in order. */
  readonly renames: string[] = []
  failRenames = 0
  afterRename: (() => void) | undefined

  public readFile(_workspaceFolderId: string, relativePath: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(relativePath)
    return Promise.resolve(bytes === undefined ? undefined : new Uint8Array(bytes))
  }

  public writeFile(_workspaceFolderId: string, relativePath: string, data: Uint8Array): Promise<void> {
    this.files.set(relativePath, new Uint8Array(data))
    return Promise.resolve()
  }

  public deleteFile(_workspaceFolderId: string, relativePath: string): Promise<void> {
    this.files.delete(relativePath)
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
    this.afterRename?.()
    return Promise.resolve()
  }
}

function createStore(
  storage: MemoryStorage,
  workspace: MemoryWorkspace,
  contentEnabled: boolean,
  onStorageIssue?: (issue: { readonly directory: string; readonly phase: 'journal' | 'manifest' }) => void,
): CheckpointStore {
  let sequence = 0
  return new CheckpointStore({
    rootPath: 'checkpoint-root',
    storage,
    workspace,
    enabled: () => true,
    contentEnabled: () => contentEnabled,
    now: () => 1_000 + sequence,
    makeId: () => `id-${++sequence}`,
    ...(onStorageIssue === undefined ? {} : { onStorageIssue }),
  })
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
    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
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
    const restored = await store.restore(summary.checkpointId, summary.expectedRevision ?? 0, 'abort')
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
      store.restore(summary.checkpointId, summary.expectedRevision ?? 0, 'abort'),
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

    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'CHECKPOINT_CONFLICT',
    })
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('external')
    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
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

    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
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

    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
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

    // The manifest is still readable, so the checkpoint itself stays listed.
    expect(await recovered.list({ workspaceFolderId: 'workspace-1' })).toHaveLength(1)
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

    await expect(store.restore(summary.checkpointId, 1, 'abort', controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('new-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('new-two')
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

    const restored = await store.restore(summary.checkpointId, 1, 'overwrite')

    expect(restored).toMatchObject({
      state: 'completed',
      restoredPaths: ['src/one.ts', 'src/two.ts', 'src/removed.ts'],
    })
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('one\n')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('two\n')
    expect(workspace.files.has('src/removed.ts')).toBe(false)
    expect((await store.get(summary.checkpointId)).state).toBe('content-ready')
  })

  it('reclaims journal and backup storage after a restore that replaced changed files', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('src/one.ts', 'src/two.ts'))
    await workspace.writeFile('workspace-1', 'src/two.ts', Buffer.from('external'))

    await store.restore(summary.checkpointId, 1, 'overwrite')

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
        skippedPaths: ['src/main.ts'],
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
