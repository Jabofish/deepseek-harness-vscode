import { createHash } from 'node:crypto'
import path from 'node:path'

import type { CheckpointCreateInput } from '@dsh-vscode/domain'
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

  public readFile(filePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(this.normalize(filePath))
    if (bytes === undefined) throw new Error('missing storage file')
    return Promise.resolve(new Uint8Array(bytes))
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
    this.afterRename?.()
    return Promise.resolve()
  }
}

function createStore(
  storage: MemoryStorage,
  workspace: MemoryWorkspace,
  contentEnabled: boolean,
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
  })
}

function changeInput(
  oldText: string | null,
  newText: string,
  relativePath = 'src/main.ts',
): CheckpointCreateInput {
  return {
    sessionId: 'session-1',
    workspaceFolderId: 'workspace-1',
    sourceChangeSetId: 'change-set-1',
    files: [{ relativePath, diff: { oldText, newText } }],
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

    await expect(store.create(changeInput('old', 'new'))).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
    expect(await store.list({ workspaceFolderId: 'workspace-1' })).toEqual([])
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
  })

  it('creates metadata-only checkpoints and never presents them as restorable', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, false)

    const summary = await store.create(changeInput('old', 'new'))
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

  it('restores the structured oldText and deletes a file that was added by the change', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    workspace.files.set('src/added.ts', Buffer.from('added'))
    const store = createStore(storage, workspace, true)

    const summary = await store.create({
      ...changeInput('old', 'new'),
      files: [
        { relativePath: 'src/main.ts', diff: { oldText: 'old', newText: 'new' } },
        { relativePath: 'src/added.ts', diff: { oldText: null, newText: 'added' } },
      ],
    })
    expect(summary).toMatchObject({ state: 'content-ready', restoreAllowed: true, fileCount: 2 })

    const restored = await store.restore(summary.checkpointId, summary.expectedRevision ?? 0, 'abort')
    expect(restored.state).toBe('completed')
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('old')
    expect(workspace.files.has('src/added.ts')).toBe(false)
  })

  it('marks a checkpoint stale and preserves external edits when conflict policy aborts', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create(changeInput('old', 'new'))
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
    const summary = await store.create(changeInput('old', 'new'))
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
    const summary = await store.create(changeInput('old', 'new'))
    const directory = checkpointDirectory('checkpoint-root', summary.checkpointId)
    await storage.writeFile(path.join(directory, 'content-0.bin'), Buffer.from('tampered'))

    await expect(store.restore(summary.checkpointId, 1, 'abort')).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    })
    expect((await store.get(summary.checkpointId)).state).toBe('corrupt')
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
  })

  it('recovers a journaled in-progress restore on the next initialization', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const first = createStore(storage, workspace, true)
    const summary = await first.create(changeInput('old', 'new'))
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
        skippedPaths: [],
      }),
    )

    const recovered = createStore(storage, workspace, true)
    await recovered.initialize()
    expect(Buffer.from(workspace.files.get('src/main.ts') ?? []).toString()).toBe('new')
    expect(await recovered.get(summary.checkpointId)).toMatchObject({ state: 'content-ready' })
    expect(storage.files.has(path.join(directory, 'journal.json'))).toBe(false)
  })

  it('rolls back already-restored files when cancellation arrives mid-transaction', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create({
      ...changeInput('old-one', 'new-one', 'src/one.ts'),
      files: [
        { relativePath: 'src/one.ts', diff: { oldText: 'old-one', newText: 'new-one' } },
        { relativePath: 'src/two.ts', diff: { oldText: 'old-two', newText: 'new-two' } },
      ],
    })
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

  it('supports partial restore only when the caller explicitly allows conflicts', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/one.ts', Buffer.from('new-one'))
    workspace.files.set('src/two.ts', Buffer.from('new-two'))
    const store = createStore(storage, workspace, true)
    const summary = await store.create({
      ...changeInput('old-one', 'new-one', 'src/one.ts'),
      files: [
        { relativePath: 'src/one.ts', diff: { oldText: 'old-one', newText: 'new-one' } },
        { relativePath: 'src/two.ts', diff: { oldText: 'old-two', newText: 'new-two' } },
      ],
    })
    await workspace.writeFile('workspace-1', 'src/two.ts', Buffer.from('external'))

    const restored = await store.restore(summary.checkpointId, 1, 'allow-partial')
    expect(restored.state).toBe('partial')
    expect(restored.skippedPaths).toEqual(['src/two.ts'])
    expect(Buffer.from(workspace.files.get('src/one.ts') ?? []).toString()).toBe('old-one')
    expect(Buffer.from(workspace.files.get('src/two.ts') ?? []).toString()).toBe('external')
    expect((await store.get(summary.checkpointId)).state).toBe('partial-restore')
  })

  it('rejects invalid paths and file-count quota before reading workspace bytes', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    const store = createStore(storage, workspace, true)
    await expect(store.create(changeInput('old', 'new', 'src/main.ts:secret'))).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    const files = Array.from({ length: 101 }, (_, index) => ({
      relativePath: `src/file-${index}.ts`,
      diff: { oldText: null, newText: '' },
    }))
    await expect(
      store.create({ sessionId: 'session-1', workspaceFolderId: 'workspace-1', files }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_QUOTA' })
  })

  it('honors cancellation before checkpoint work begins', async () => {
    const storage = new MemoryStorage()
    const workspace = new MemoryWorkspace()
    workspace.files.set('src/main.ts', Buffer.from('new'))
    const store = createStore(storage, workspace, true)
    const controller = new AbortController()
    controller.abort()

    await expect(store.create(changeInput('old', 'new'), controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
  })
})
