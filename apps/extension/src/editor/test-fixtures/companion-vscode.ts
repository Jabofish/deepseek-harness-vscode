import path from 'node:path'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import type * as vscode from 'vscode'
import { vi, type Mock } from 'vitest'

export class FixtureUri {
  public readonly authority = ''
  public constructor(
    public readonly fsPath: string,
    public readonly scheme = 'file',
  ) {}
  public get path(): string {
    return this.fsPath
  }
  public toString(): string {
    return `${this.scheme}:${this.fsPath}`
  }
  public static file(file: string): FixtureUri {
    return new FixtureUri(file)
  }
  public static joinPath(root: FixtureUri, ...parts: string[]): FixtureUri {
    return new FixtureUri(path.join(root.fsPath, ...parts), root.scheme)
  }
  public static from(value: { scheme: string; path: string }): FixtureUri {
    return new FixtureUri(value.path, value.scheme)
  }
}
export class FixturePosition {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}
export class FixtureRange {
  public readonly start: FixturePosition
  public readonly end: FixturePosition
  public constructor(
    start: number | FixturePosition,
    column: number | FixturePosition,
    end?: number,
    endColumn?: number,
  ) {
    this.start = typeof start === 'number' ? new FixturePosition(start, Number(column)) : start
    this.end = typeof column === 'number' ? new FixturePosition(end ?? 0, endColumn ?? 0) : column
  }
  public get isEmpty(): boolean {
    return this.start.line === this.end.line && this.start.character === this.end.character
  }
}
export class FixtureDocument {
  public readonly save = vi.fn(async (): Promise<boolean> => {
    await writeFile(this.uri.fsPath, this.text)
    this.isDirty = false
    return true
  })
  public version = 1
  public isDirty = true
  public isClosed = false
  public readonly languageId = 'typescript'
  public constructor(
    public readonly uri: FixtureUri,
    public text: string,
  ) {}
  public get lineCount(): number {
    return this.text.split('\n').length
  }
  public lineAt(line: number): { text: string } {
    return { text: this.text.split('\n')[line] ?? '' }
  }
  public offsetAt(position: FixturePosition): number {
    return (
      this.text
        .split('\n')
        .slice(0, position.line)
        .reduce((size, line) => size + line.length + 1, 0) + position.character
    )
  }
  public positionAt(offset: number): FixturePosition {
    const preceding = this.text.slice(0, offset).split('\n')
    return new FixturePosition(preceding.length - 1, preceding.at(-1)?.length ?? 0)
  }
  public getText(range?: FixtureRange): string {
    return range === undefined
      ? this.text
      : this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end))
  }
  public vscode(): vscode.TextDocument {
    return this as unknown as vscode.TextDocument
  }
}
export class FixtureEditor {
  public selection = new FixtureRange(0, 0, 0, 5)
  public readonly revealRange: Mock<(...args: unknown[]) => void> = vi.fn()
  public readonly edit = vi.fn(
    (build: (builder: { replace(range: FixtureRange, text: string): void }) => void) => {
      const edits: { start: number; end: number; text: string }[] = []
      build({
        replace: (range, text) =>
          edits.push({
            start: this.document.offsetAt(range.start),
            end: this.document.offsetAt(range.end),
            text,
          }),
      })
      for (const edit of edits.sort((a, b) => b.start - a.start))
        this.document.text =
          this.document.text.slice(0, edit.start) + edit.text + this.document.text.slice(edit.end)
      this.document.version += 1
      this.document.isDirty = true
      return Promise.resolve(true)
    },
  )
  public constructor(public readonly document: FixtureDocument) {}
}
export class FixtureWorkspaceEdit {
  public readonly changes: { uri: FixtureUri; range: FixtureRange; text: string }[] = []
  public replace(uri: FixtureUri, range: FixtureRange, text: string): void {
    this.changes.push({ uri, range, text })
  }
}
export const state = {
  trusted: true,
  current: true,
  remoteName: undefined as string | undefined,
  folders: [] as vscode.WorkspaceFolder[],
  documents: new Map<string, FixtureDocument>(),
  editor: undefined as FixtureEditor | undefined,
  diagnostics: [] as unknown[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}
interface NativeMocks {
  info: Mock<(...args: unknown[]) => Promise<string | undefined>>
  warning: Mock<(...args: unknown[]) => Promise<string | undefined>>
  error: Mock<(...args: unknown[]) => Promise<string | undefined>>
  pick: Mock<(...args: unknown[]) => Promise<unknown>>
  files: Mock<(...args: unknown[]) => Promise<readonly FixtureUri[] | undefined>>
  execute: Mock<(name: string, ...args: unknown[]) => Promise<unknown>>
  stat: Mock<(uri: FixtureUri) => Promise<{ type: number; size: number }>>
  progress: Mock<
    (
      options: unknown,
      task: (
        progress: unknown,
        token: { onCancellationRequested(callback: () => void): { dispose(): void } },
      ) => Promise<unknown>,
    ) => Promise<unknown>
  >
  applyEdit: Mock<(edit: FixtureWorkspaceEdit) => Promise<boolean>>
}
export const native: NativeMocks = {
  info: vi.fn().mockResolvedValue(undefined),
  warning: vi.fn().mockResolvedValue('Decline'),
  error: vi.fn().mockResolvedValue(undefined),
  pick: vi.fn().mockResolvedValue(undefined),
  files: vi.fn().mockResolvedValue(undefined),
  execute: vi.fn((name: string, ...args: unknown[]) => Promise.resolve(state.handlers.get(name)?.(...args))),
  stat: vi.fn(async (uri: FixtureUri) => {
    const info = await lstat(uri.fsPath)
    return { type: info.isSymbolicLink() ? 65 : info.isFile() ? 1 : 2, size: info.size }
  }),
  progress: vi.fn(
    async (
      _options: unknown,
      task: (
        progress: unknown,
        token: { onCancellationRequested(callback: () => void): { dispose(): void } },
      ) => Promise<unknown>,
    ) => task({}, { onCancellationRequested: () => ({ dispose() {} }) }),
  ),
  applyEdit: vi.fn((edit: FixtureWorkspaceEdit) => {
    const byDocument = new Map<string, FixtureDocument>()
    for (const change of edit.changes) {
      const document = state.documents.get(change.uri.toString())
      if (document !== undefined) byDocument.set(change.uri.toString(), document)
    }
    for (const [key, document] of byDocument) {
      const changes = edit.changes
        .filter((change) => change.uri.toString() === key)
        .map((change) => ({
          start: document.offsetAt(change.range.start),
          end: document.offsetAt(change.range.end),
          text: change.text,
        }))
        .sort((left, right) => right.start - left.start)
      for (const change of changes)
        document.text = document.text.slice(0, change.start) + change.text + document.text.slice(change.end)
      document.version += 1
      document.isDirty = true
    }
    return Promise.resolve(true)
  }),
}
export function createCompanionVscodeApi(): Record<string, unknown> {
  return {
    Uri: FixtureUri,
    Range: FixtureRange,
    Selection: FixtureRange,
    Position: FixturePosition,
    WorkspaceEdit: FixtureWorkspaceEdit,
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    FileType: { File: 1, SymbolicLink: 64 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    ProgressLocation: { Notification: 15 },
    env: {
      get remoteName() {
        return state.remoteName
      },
    },
    window: {
      get activeTextEditor() {
        return state.editor
      },
      showInformationMessage: native.info,
      showWarningMessage: native.warning,
      showErrorMessage: native.error,
      showQuickPick: native.pick,
      showOpenDialog: native.files,
      withProgress: native.progress,
      showTextDocument: (document: FixtureDocument) => {
        state.editor = new FixtureEditor(document)
        return Promise.resolve(state.editor)
      },
    },
    languages: { getDiagnostics: () => state.diagnostics },
    commands: { executeCommand: native.execute },
    workspace: {
      get isTrusted() {
        return state.trusted
      },
      get workspaceFolders() {
        return state.folders
      },
      get textDocuments() {
        return [...state.documents.values()]
      },
      fs: { stat: native.stat },
      applyEdit: native.applyEdit,
      openTextDocument: async (uri: FixtureUri) => {
        let document = state.documents.get(uri.toString())
        if (document === undefined) {
          document = new FixtureDocument(uri, await readFile(uri.fsPath, 'utf8'))
          state.documents.set(uri.toString(), document)
        }
        return document
      },
      registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
    },
  }
}
export function resetCompanionFixture(): void {
  state.trusted = true
  state.current = true
  state.remoteName = undefined
  state.folders = []
  state.documents.clear()
  state.editor = undefined
  state.diagnostics = []
  state.handlers.clear()
  for (const key of Object.keys(native) as (keyof NativeMocks)[]) native[key].mockClear()
  native.warning.mockReset().mockResolvedValue('Decline')
  native.info.mockReset().mockResolvedValue(undefined)
  native.pick.mockReset().mockResolvedValue(undefined)
  native.files.mockReset().mockResolvedValue(undefined)
}
