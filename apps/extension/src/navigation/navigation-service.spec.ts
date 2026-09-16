import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import * as vscode from 'vscode'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NavigationService } from './navigation-service.js'
import { workspaceFolderId } from '../editor/workspace-path-guard.js'

vi.mock('vscode', () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
    public get column(): number {
      return this.character
    }
  }
  class Range {
    public readonly start: Position
    public readonly end: Position
    public constructor(startLine: number, startColumn: number, endLine: number, endColumn: number) {
      this.start = new Position(startLine, startColumn)
      this.end = new Position(endLine, endColumn)
    }
  }
  class Selection {
    public constructor(
      public readonly start: Position,
      public readonly end: Position,
    ) {}
  }
  return {
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: {
      file: (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` }),
      parse: (value: string) => ({
        scheme: value.slice(0, value.indexOf(':')),
        fsPath: value,
        toString: () => value,
      }),
    },
  }
})

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-navigation-'))
  temporaryRoots.push(root)
  return root
}

interface Harness {
  readonly service: NavigationService
  readonly folderId: string
  readonly root: string
  readonly editor: { selection?: unknown; revealRange: ReturnType<typeof vi.fn> }
  readonly showTextDocument: ReturnType<typeof vi.fn>
  readonly executeCommand: ReturnType<typeof vi.fn>
  readonly revealRange: ReturnType<typeof vi.fn>
  readonly lines: string[]
}

function createHarness(
  root: string,
  lines: readonly string[] = ['first', 'second', 'third'],
  statType: number = vscode.FileType.File,
): Harness {
  const folder = { uri: { scheme: 'file', fsPath: root }, name: 'workspace', index: 0 }
  const document = {
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
  }
  const editor: { selection?: unknown; revealRange: ReturnType<typeof vi.fn> } = {
    revealRange: vi.fn(),
  }
  const showTextDocument = vi.fn(() => Promise.resolve(editor))
  const executeCommand = vi.fn(() => Promise.resolve())
  const workspace = {
    workspaceFolders: [folder],
    fs: {
      stat: vi.fn(() => Promise.resolve({ type: statType })),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      delete: vi.fn(),
      rename: vi.fn(),
    },
    openTextDocument: vi.fn(() => Promise.resolve(document)),
  }
  const window = { showTextDocument }
  const service = new NavigationService({
    workspace: workspace as unknown as typeof vscode.workspace,
    window: window as unknown as typeof vscode.window,
    commands: { executeCommand } as unknown as typeof vscode.commands,
  })
  return {
    service,
    folderId: workspaceFolderId(folder as unknown as vscode.WorkspaceFolder),
    root,
    editor,
    showTextDocument,
    executeCommand,
    revealRange: editor.revealRange,
    lines: [...lines],
  }
}

describe('NavigationService', () => {
  it('opens a file at the 0-based line the change location carries', async () => {
    const root = temporaryRoot()
    mkdirSync(path.join(root, 'src'), { recursive: true })
    writeFileSync(path.join(root, 'src', 'a.ts'), 'first\nsecond\nthird\n')
    const harness = createHarness(root)

    await harness.service.openFile(harness.folderId, 'src/a.ts', {
      start: { line: 2, column: 0 },
      end: { line: 2, column: 0 },
    })

    expect(harness.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
      preview: true,
      preserveFocus: false,
    })
    expect(harness.editor.selection).toMatchObject({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 0 },
    })
    expect(harness.revealRange).toHaveBeenCalledWith(expect.anything(), 2)
  })

  it('keeps a stale line hint from failing an open that already happened', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'shrunk.ts'), 'only\n')
    const harness = createHarness(root, ['only'])

    await harness.service.openFile(harness.folderId, 'shrunk.ts', {
      start: { line: 7, column: 0 },
      end: { line: 7, column: 0 },
    })

    expect(harness.showTextDocument).toHaveBeenCalledTimes(1)
    expect(harness.editor.selection).toMatchObject({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    })
    expect(harness.revealRange).toHaveBeenCalledTimes(1)
  })

  it('forwards preserve-focus and refuses a malformed range before positioning', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'a.ts'), 'first\nsecond\nthird\n')
    const harness = createHarness(root)

    await harness.service.openFile(
      harness.folderId,
      'a.ts',
      { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
      undefined,
      true,
    )
    expect(harness.showTextDocument).toHaveBeenCalledWith(expect.anything(), {
      preview: true,
      preserveFocus: true,
    })

    await expect(
      harness.service.openFile(harness.folderId, 'a.ts', {
        start: { line: 1, column: 4 },
        end: { line: 1, column: 1 },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(harness.revealRange).toHaveBeenCalledTimes(1)
  })

  it('refuses a path outside the workspace and a directory target', async () => {
    const root = temporaryRoot()
    mkdirSync(path.join(root, 'src'), { recursive: true })
    const harness = createHarness(root)

    await expect(harness.service.openFile(harness.folderId, '../escape.ts')).rejects.toMatchObject({
      code: 'PATH_NOT_ALLOWED',
    })
    expect(harness.showTextDocument).not.toHaveBeenCalled()

    const directoryHarness = createHarness(root, ['first'], vscode.FileType.Directory)
    await expect(
      directoryHarness.service.revealLine(directoryHarness.folderId, 'src', 0),
    ).rejects.toMatchObject({ code: 'PATH_NOT_ALLOWED' })
    expect(directoryHarness.showTextDocument).not.toHaveBeenCalled()
  })

  it('reveals a line with an explicit column and defaults the column to zero', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'a.ts'), 'first\nsecond\nthird\n')
    const harness = createHarness(root)

    await harness.service.revealLine(harness.folderId, 'a.ts', 1, 3)

    expect(harness.editor.selection).toMatchObject({
      start: { line: 1, character: 3 },
      end: { line: 1, character: 3 },
    })
  })

  it('shows a resolved file in the explorer through the VS Code command', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'a.ts'), 'first\n')
    const harness = createHarness(root)

    await harness.service.showInExplorer(harness.folderId, 'a.ts')

    expect(harness.executeCommand).toHaveBeenCalledWith(
      'revealInExplorer',
      expect.objectContaining({ scheme: 'file', fsPath: path.join(root, 'a.ts') }),
    )
  })

  it('opens a diff against the current file and bounds the before text', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'a.ts'), 'first\n')
    const harness = createHarness(root)

    await harness.service.openDiff(harness.folderId, 'a.ts', 'before\ntext')

    expect(harness.executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.objectContaining({ scheme: 'data' }),
      expect.objectContaining({ fsPath: path.join(root, 'a.ts') }),
      'a.ts',
    )

    const oversized = createHarness(root)
    await expect(
      oversized.service.openDiff(oversized.folderId, 'a.ts', 'x'.repeat(262_145)),
    ).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' })
    expect(oversized.executeCommand).not.toHaveBeenCalled()
  })

  it('refuses work after disposal and when the caller aborted', async () => {
    const root = temporaryRoot()
    writeFileSync(path.join(root, 'a.ts'), 'first\n')
    const harness = createHarness(root)
    const controller = new AbortController()

    await expect(
      harness.service.showInExplorer(harness.folderId, 'a.ts', controller.signal),
    ).resolves.toBeUndefined()
    controller.abort()
    await expect(
      harness.service.showInExplorer(harness.folderId, 'a.ts', controller.signal),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(harness.executeCommand).toHaveBeenCalledTimes(1)

    harness.service.dispose()
    await expect(harness.service.openFile(harness.folderId, 'a.ts')).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
  })
})
