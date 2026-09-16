import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as vscode from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, type EditorContextRange } from '@dsh-vscode/domain'

import { workspaceFolderId, WorkspacePathGuard } from './workspace-path-guard.js'

vi.mock('vscode', () => {
  // The real Range reshapes a numeric quadruple into Position objects; the
  // guard relies on that, so the double keeps the same shape.
  class Range {
    public readonly start: { readonly line: number; readonly column: number }
    public readonly end: { readonly line: number; readonly column: number }
    public constructor(startLine: number, startColumn: number, endLine: number, endColumn: number) {
      this.start = { line: startLine, column: startColumn }
      this.end = { line: endLine, column: endColumn }
    }
  }
  return {
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Range,
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    },
  }
})

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-workspace-guard-'))
  temporaryRoots.push(root)
  return root
}

function createDirectoryLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

interface Harness {
  readonly guard: WorkspacePathGuard
  readonly folderId: string
  readonly root: string
  readonly stat: ReturnType<typeof vi.fn>
}

function createHarness(
  root: string,
  stat: (uri: { readonly fsPath: string }) => Promise<{ readonly type: number }>,
): Harness {
  const folder = { uri: { scheme: 'file', fsPath: root }, name: 'workspace', index: 0 }
  const workspace = {
    workspaceFolders: [folder],
    fs: { stat: vi.fn(stat), readFile: vi.fn(), writeFile: vi.fn(), delete: vi.fn(), rename: vi.fn() },
  }
  return {
    guard: new WorkspacePathGuard(workspace as unknown as typeof vscode.workspace),
    folderId: workspaceFolderId(folder as unknown as vscode.WorkspaceFolder),
    root,
    stat: workspace.fs.stat,
  }
}

describe('WorkspacePathGuard', () => {
  it('resolves a nested relative path inside the owning workspace folder', () => {
    const root = temporaryRoot()
    mkdirSync(path.join(root, 'src'), { recursive: true })
    const harness = createHarness(root, () => Promise.resolve({ type: vscode.FileType.File }))

    const resolved = harness.guard.resolve(harness.folderId, 'src/feature.ts')

    expect(resolved.relativePath).toBe('src/feature.ts')
    expect(resolved.uri.fsPath).toBe(path.join(root, 'src', 'feature.ts'))
    expect(resolved.workspaceFolder.uri.fsPath).toBe(root)
  })

  it('refuses relative paths that are not canonical workspace paths', () => {
    const root = temporaryRoot()
    mkdirSync(root, { recursive: true })
    const harness = createHarness(root, () => Promise.resolve({ type: vscode.FileType.File }))
    const outside = path.join(root, '..', 'escape.ts')

    for (const candidate of [
      '',
      '../escape.ts',
      '/etc/passwd',
      'src\\main.ts',
      'C:/windows',
      'file.ts:ads',
      './src',
    ])
      expect(() => harness.guard.resolve(harness.folderId, candidate)).toThrow(AppError)
    expect(() => harness.guard.resolve(harness.folderId, 'src/../../escape.ts')).toThrow(AppError)
    expect(harness.guard.resolve(harness.folderId, 'safe.ts').uri.fsPath).not.toBe(outside)
  })

  it('refuses an unknown workspace folder id', () => {
    const root = temporaryRoot()
    const harness = createHarness(root, () => Promise.resolve({ type: vscode.FileType.File }))

    expect(() => harness.guard.resolve('workspace:0123456789abcdef', 'src/main.ts')).toThrow(AppError)
  })

  it('refuses a new file whose linked parent directory leaves the workspace', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    mkdirSync(folder)
    mkdirSync(outside)
    createDirectoryLink(outside, path.join(folder, 'linked'))
    writeFileSync(path.join(outside, 'present.ts'), 'export {}\n')
    const harness = createHarness(folder, () => Promise.resolve({ type: vscode.FileType.File }))

    expect(() => harness.guard.resolve(harness.folderId, 'linked/present.ts')).toThrow(AppError)
    // A checkpoint restore recreates the file it observed: the boundary must not
    // depend on the target still existing.
    expect(() => harness.guard.resolve(harness.folderId, 'linked/created.ts')).toThrow(AppError)
    expect(() => harness.guard.resolve(harness.folderId, 'linked/nested/created.ts')).toThrow(AppError)
  })

  it('still resolves a new file through a linked directory that stays inside the workspace', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    mkdirSync(path.join(folder, 'packages', 'app'), { recursive: true })
    createDirectoryLink(path.join(folder, 'packages'), path.join(folder, 'linked-packages'))
    const harness = createHarness(folder, () => Promise.resolve({ type: vscode.FileType.File }))

    expect(harness.guard.resolve(harness.folderId, 'linked-packages/app/new.ts').uri.fsPath).toBe(
      path.join(folder, 'linked-packages', 'app', 'new.ts'),
    )
  })

  it('accepts only an existing regular file', async () => {
    const root = temporaryRoot()
    mkdirSync(root, { recursive: true })
    const harness = createHarness(root, () => Promise.resolve({ type: vscode.FileType.File }))
    const resolved = harness.guard.resolve(harness.folderId, 'src/main.ts')

    await expect(harness.guard.assertRegularFile(resolved)).resolves.toBeUndefined()

    harness.stat.mockResolvedValueOnce({ type: vscode.FileType.Directory })
    await expect(harness.guard.assertRegularFile(resolved)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })

    harness.stat.mockResolvedValueOnce({ type: vscode.FileType.SymbolicLink | vscode.FileType.File })
    await expect(harness.guard.assertRegularFile(resolved)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })

    harness.stat.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'FileNotFound' }))
    await expect(harness.guard.assertRegularFile(resolved)).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
  })

  it('derives a canonical relative path only for files inside the folder', () => {
    const root = temporaryRoot()
    const folder = path.join(root, 'workspace')
    mkdirSync(path.join(folder, 'src'), { recursive: true })
    const harness = createHarness(folder, () => Promise.resolve({ type: vscode.FileType.File }))
    const workspaceFolder = { uri: { scheme: 'file', fsPath: folder } } as unknown as vscode.WorkspaceFolder

    expect(
      harness.guard.relativePath(workspaceFolder, vscode.Uri.file(path.join(folder, 'src', 'a.ts'))),
    ).toBe('src/a.ts')
    expect(() =>
      harness.guard.relativePath(workspaceFolder, vscode.Uri.file(path.join(root, 'outside.ts'))),
    ).toThrow(AppError)
    expect(() =>
      harness.guard.relativePath(workspaceFolder, {
        scheme: 'https',
        fsPath: path.join(folder, 'src', 'a.ts'),
      } as unknown as vscode.Uri),
    ).toThrow(AppError)
  })

  it('clamps a stale hint into the document and still refuses a malformed range', () => {
    const root = temporaryRoot()
    const harness = createHarness(root, () => Promise.resolve({ type: vscode.FileType.File }))
    const document = {
      lineCount: 3,
      lineAt: (line: number) => ({ text: ['first', 'second', 'third'][line] ?? '' }),
    } as unknown as vscode.TextDocument
    const range: EditorContextRange = { start: { line: 1, column: 2 }, end: { line: 2, column: 5 } }

    expect(harness.guard.clampRange(document, range)).toMatchObject({
      start: { line: 1, column: 2 },
      end: { line: 2, column: 5 },
    })
    // A location the tool produced can outlive the lines it pointed at: the
    // hint clamps to the document instead of failing the open around it.
    expect(
      harness.guard.clampRange(document, {
        start: { line: 9, column: 0 },
        end: { line: 9, column: 4 },
      }),
    ).toMatchObject({ start: { line: 2, column: 0 }, end: { line: 2, column: 4 } })
    expect(
      harness.guard.clampRange(document, {
        start: { line: 0, column: 6 },
        end: { line: 0, column: 9 },
      }),
    ).toMatchObject({ start: { line: 0, column: 5 }, end: { line: 0, column: 5 } })

    for (const invalid of [
      { start: { line: 0, column: 0 }, end: { line: -1, column: 0 } },
      { start: { line: 0.5, column: 0 }, end: { line: 1, column: 0 } },
      { start: { line: 2, column: 0 }, end: { line: 1, column: 0 } },
      { start: { line: 0, column: Number.NaN }, end: { line: 0, column: 0 } },
    ] satisfies readonly EditorContextRange[])
      expect(() => harness.guard.clampRange(document, invalid)).toThrow(AppError)
  })

  it('identifies one workspace folder independently of its display name', () => {
    const first = { uri: { fsPath: path.resolve('one') }, name: 'a' } as unknown as vscode.WorkspaceFolder
    const second = { uri: { fsPath: path.resolve('two') }, name: 'a' } as unknown as vscode.WorkspaceFolder

    expect(workspaceFolderId(first)).toBe(workspaceFolderId(first))
    expect(workspaceFolderId(first)).not.toBe(workspaceFolderId(second))
  })
})
