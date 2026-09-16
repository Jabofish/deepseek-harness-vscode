import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vscode', () => ({
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  Range: class Range {},
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}))

import type * as vscode from 'vscode'

import { workspaceFolderId } from '../editor/workspace-path-guard.js'
import {
  createVscodeCheckpointStorage,
  createVscodeCheckpointWorkspace,
} from './vscode-checkpoint-adapter.js'

interface FakeEntry {
  readonly type: number
  readonly bytes?: Uint8Array
}

interface WorkspaceHarness {
  readonly workspace: typeof vscode.workspace
  readonly folderId: string
  readonly readFile: ReturnType<typeof vi.fn>
  readonly rename: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly entries: Map<string, FakeEntry>
  put(relativePath: string, type: number, text?: string): void
  has(relativePath: string): boolean
  bytes(relativePath: string): Uint8Array | undefined
  failStat(fsPath: string, error: Error): void
  writeCount(): number
}

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-checkpoint-adapter-'))
  temporaryRoots.push(root)
  return root
}

function fileNotFound(): Error {
  return Object.assign(new Error('ENOENT: no such file or directory'), { code: 'FileNotFound' })
}

function createHarness(root: string): WorkspaceHarness {
  const folder = { uri: { scheme: 'file', fsPath: root }, name: 'workspace', index: 0 }
  const entries = new Map<string, FakeEntry>()
  const failures = new Map<string, Error>()
  const key = (fsPath: string): string => (process.platform === 'win32' ? fsPath.toLowerCase() : fsPath)
  let writes = 0
  const fs = {
    stat: vi.fn((uri: { readonly fsPath: string }) => {
      const failure = failures.get(key(uri.fsPath))
      if (failure !== undefined) return Promise.reject(failure)
      const entry = entries.get(key(uri.fsPath))
      if (entry === undefined) return Promise.reject(fileNotFound())
      return Promise.resolve({ type: entry.type, size: entry.bytes?.byteLength ?? 0, ctime: 0, mtime: 0 })
    }),
    readFile: vi.fn((uri: { readonly fsPath: string }) => {
      const failure = failures.get(key(uri.fsPath))
      if (failure !== undefined) return Promise.reject(failure)
      const entry = entries.get(key(uri.fsPath))
      if (entry === undefined) return Promise.reject(fileNotFound())
      return Promise.resolve(entry.bytes ?? new Uint8Array())
    }),
    writeFile: vi.fn((uri: { readonly fsPath: string }, data: Uint8Array) => {
      writes += 1
      entries.set(key(uri.fsPath), { type: 1, bytes: data })
      return Promise.resolve()
    }),
    delete: vi.fn((uri: { readonly fsPath: string }, options?: { readonly recursive?: boolean }) => {
      const target = key(uri.fsPath)
      if (!entries.has(target)) return Promise.reject(fileNotFound())
      for (const candidate of [...entries.keys()]) {
        if (
          candidate === target ||
          (options?.recursive === true && candidate.startsWith(`${target}${path.sep}`))
        )
          entries.delete(candidate)
      }
      return Promise.resolve()
    }),
    rename: vi.fn(
      (
        source: { readonly fsPath: string },
        destination: { readonly fsPath: string },
        options?: { readonly overwrite?: boolean },
      ) => {
        const from = key(source.fsPath)
        const to = key(destination.fsPath)
        const entry = entries.get(from)
        if (entry === undefined) return Promise.reject(fileNotFound())
        if (entries.has(to) && options?.overwrite !== true) return Promise.reject(new Error('EEXIST'))
        entries.set(to, entry)
        entries.delete(from)
        return Promise.resolve()
      },
    ),
    createDirectory: vi.fn((uri: { readonly fsPath: string }) => {
      entries.set(key(uri.fsPath), { type: 2 })
      return Promise.resolve()
    }),
    readDirectory: vi.fn((uri: { readonly fsPath: string }) => {
      const prefix = `${key(uri.fsPath)}${path.sep}`
      const children = new Map<string, number>()
      for (const [candidate, entry] of entries) {
        if (!candidate.startsWith(prefix)) continue
        const rest = candidate.slice(prefix.length)
        const [name, ...nested] = rest.split(path.sep)
        if (name === undefined || name === '') continue
        children.set(name, nested.length === 0 ? entry.type : 2)
      }
      return Promise.resolve([...children.entries()])
    }),
  }
  return {
    workspace: {
      workspaceFolders: [folder],
      fs,
    } as unknown as typeof vscode.workspace,
    folderId: workspaceFolderId(folder as unknown as vscode.WorkspaceFolder),
    readFile: fs.readFile,
    rename: fs.rename,
    remove: fs.delete,
    entries,
    put: (relativePath, type, text) => {
      entries.set(key(path.join(root, ...relativePath.split('/'))), {
        type,
        ...(text === undefined ? {} : { bytes: new TextEncoder().encode(text) }),
      })
    },
    has: (relativePath) => entries.has(key(path.join(root, ...relativePath.split('/')))),
    bytes: (relativePath) => entries.get(key(path.join(root, ...relativePath.split('/'))))?.bytes,
    failStat: (fsPath, error) => {
      failures.set(key(fsPath), error)
    },
    writeCount: () => writes,
  }
}

describe('checkpoint workspace access', () => {
  it('reads a regular file and reports absence only for FileNotFound', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src/note.txt', 1, 'hello')
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await expect(workspace.readFile(harness.folderId, 'src/note.txt')).resolves.toEqual(
      new TextEncoder().encode('hello'),
    )
    await expect(workspace.readFile(harness.folderId, 'src/missing.txt')).resolves.toBeUndefined()
  })

  it('turns any other stat failure into a refusal instead of an absence', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src/locked.txt', 1, 'secret')
    harness.failStat(
      path.join(root, 'src', 'locked.txt'),
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    )
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    // Absence is a positive finding that authorises a restore to delete the path,
    // so an unreadable file must never be reported as missing.
    await expect(workspace.readFile(harness.folderId, 'src/locked.txt')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    expect(harness.readFile).not.toHaveBeenCalled()
  })

  it('refuses to read through a directory or a symlink', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src', 2)
    harness.put('src/link.txt', 1 | 64, 'linked')
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await expect(workspace.readFile(harness.folderId, 'src')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    await expect(workspace.readFile(harness.folderId, 'src/link.txt')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    await expect(workspace.readFile(harness.folderId, '../outside.txt')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
  })

  it('writes a new file but refuses a directory or symlink target', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src', 2)
    harness.put('src/link.txt', 64, 'linked')
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await workspace.writeFile(harness.folderId, 'src/created.txt', new TextEncoder().encode('restored'))
    expect(harness.bytes('src/created.txt')).toEqual(new TextEncoder().encode('restored'))
    await expect(
      workspace.writeFile(harness.folderId, 'src', new TextEncoder().encode('clobber')),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    await expect(
      workspace.writeFile(harness.folderId, 'src/link.txt', new TextEncoder().encode('clobber')),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(harness.writeCount()).toBe(1)
  })

  it('deletes a regular file, ignores a missing one, and never deletes through a symlink', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src/gone.txt', 1, 'content')
    harness.put('src/link.txt', 64, 'linked')
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await workspace.deleteFile(harness.folderId, 'src/gone.txt')
    expect(harness.has('src/gone.txt')).toBe(false)
    await expect(workspace.deleteFile(harness.folderId, 'src/gone.txt')).resolves.toBeUndefined()
    await expect(workspace.deleteFile(harness.folderId, 'src/link.txt')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    expect(harness.has('src/link.txt')).toBe(true)
  })

  it('renames a temp file onto its target and refuses a directory destination', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src/target.txt', 1, 'old')
    harness.put('src', 2)
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await workspace.writeFile(harness.folderId, 'src/temp.txt', new TextEncoder().encode('new'))
    await workspace.renameFile(harness.folderId, 'src/temp.txt', 'src/target.txt', true)
    expect(harness.rename).toHaveBeenCalledWith(
      { scheme: 'file', fsPath: path.join(root, 'src', 'temp.txt') },
      { scheme: 'file', fsPath: path.join(root, 'src', 'target.txt') },
      { overwrite: true },
    )
    expect(harness.bytes('src/target.txt')).toEqual(new TextEncoder().encode('new'))
    await expect(
      workspace.renameFile(harness.folderId, 'src/missing.txt', 'src/target.txt', true),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    await expect(workspace.renameFile(harness.folderId, 'src/target.txt', 'src', true)).rejects.toMatchObject(
      { code: 'PATH_NOT_ALLOWED' },
    )
  })
  it('refuses a symlinked rename source and never touches the filesystem for it', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('src/link.txt', 64, 'linked')
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    await expect(
      workspace.renameFile(harness.folderId, 'src/link.txt', 'src/target.txt', true),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(harness.rename).not.toHaveBeenCalled()
  })

  it('refuses a restore target under a linked directory before writing anything', async () => {
    const root = temporaryRoot()
    const outside = temporaryRoot()
    symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const harness = createHarness(root)
    harness.put('linked', 2)
    const workspace = createVscodeCheckpointWorkspace(harness.workspace)

    // The linked directory resolves outside the workspace, so a checkpoint
    // restore must never create or replace a file through it.
    await expect(
      workspace.writeFile(harness.folderId, 'linked/ghost.txt', new TextEncoder().encode('escaped')),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    await expect(workspace.deleteFile(harness.folderId, 'linked/present.txt')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    expect(harness.writeCount()).toBe(0)
    expect(harness.remove).not.toHaveBeenCalled()
  })
})

describe('checkpoint storage access', () => {
  it('reports a missing metadata file as undefined and keeps other failures', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('checkpoints/manifest.json', 1, '{}')
    harness.failStat(
      path.join(root, 'checkpoints', 'manifest.json'),
      Object.assign(new Error('EBUSY'), { code: 'EBUSY' }),
    )
    const storage = createVscodeCheckpointStorage(harness.workspace)

    await expect(storage.readFile(path.join(root, 'checkpoints', 'absent.json'))).resolves.toBeUndefined()
    await expect(storage.readFile(path.join(root, 'checkpoints', 'manifest.json'))).rejects.toMatchObject({
      code: 'EBUSY',
    })
  })

  it('lists directories and files only, and forwards the delete and rename options', async () => {
    const root = temporaryRoot()
    const harness = createHarness(root)
    harness.put('checkpoints/manifest.json', 1, '{}')
    harness.put('checkpoints/backup-0.bin', 1, 'bytes')
    harness.put('checkpoints/nested', 2)
    const storage = createVscodeCheckpointStorage(harness.workspace)

    const listed = await storage.list(path.join(root, 'checkpoints'))
    expect([...listed].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
      { name: 'backup-0.bin', kind: 'file' },
      { name: 'manifest.json', kind: 'file' },
      { name: 'nested', kind: 'directory' },
    ])

    await storage.delete(path.join(root, 'checkpoints', 'nested'), true)
    expect(harness.entries.has(path.join(root, 'checkpoints', 'nested'))).toBe(false)

    await storage.rename(
      path.join(root, 'checkpoints', 'backup-0.bin'),
      path.join(root, 'checkpoints', 'journal.json'),
      true,
    )
    expect(harness.rename).toHaveBeenCalledWith(
      { scheme: 'file', fsPath: path.join(root, 'checkpoints', 'backup-0.bin') },
      { scheme: 'file', fsPath: path.join(root, 'checkpoints', 'journal.json') },
      { overwrite: true },
    )
  })
})
