import path from 'node:path'

import * as vscode from 'vscode'
import type { TextDocument, TextEditor, WorkspaceFolder } from 'vscode'
import { describe, expect, it, vi } from 'vitest'
import type { EditorContextOwner } from '@dsh-vscode/domain'

import { EditorContextProvider, DSH_CHAT_VIEW_OWNER_ID } from './editor-context-provider.js'
import { workspaceFolderId } from './workspace-path-guard.js'

vi.mock('vscode', () => {
  class Position {
    public constructor(
      public readonly line: number,
      public readonly character: number,
    ) {}
  }

  class Range {
    public readonly start: Position
    public readonly end: Position

    public constructor(
      startOrLine: Position | number,
      startCharacterOrEnd: number | Position,
      endLine?: number,
      endCharacter?: number,
    ) {
      if (typeof startOrLine === 'number') {
        this.start = new Position(startOrLine, startCharacterOrEnd as number)
        this.end = new Position(endLine as number, endCharacter as number)
      } else {
        this.start = startOrLine
        this.end = startCharacterOrEnd as Position
      }
    }
  }

  return {
    FileType: { File: 1, SymbolicLink: 64 },
    Position,
    Range,
    Uri: {
      file: (fsPath: string) => ({
        scheme: 'file',
        fsPath,
        toString: () => `file:${fsPath}`,
      }),
    },
  }
})

const source = ['function greet(name: string) {', '  return `Hello ${name}`', '}'].join('\n')
const workspaceRoot = path.resolve('editor-context-provider-test-workspace')
const documentPath = path.join(workspaceRoot, 'src', 'greet.ts')

interface Harness {
  readonly document: TextDocument
  readonly owner: EditorContextOwner
  readonly executeCommand: ReturnType<typeof vi.fn>
  readonly setDocument: (nextSource: string, nextVersion: number) => void
  readonly provider: EditorContextProvider
}

function createHarness(symbols: unknown): Harness {
  let currentSource = source
  let currentVersion = 1
  const uri = vscode.Uri.file(documentPath)
  const folder = {
    uri: { fsPath: workspaceRoot },
    name: 'editor-context-provider-test-workspace',
    index: 0,
  } as unknown as WorkspaceFolder
  const getLines = (): readonly string[] => currentSource.split('\n')
  const offsetAt = (position: { readonly line: number; readonly character: number }): number => {
    const lines = getLines()
    let offset = 0
    for (let line = 0; line < position.line; line += 1) offset += (lines[line] ?? '').length + 1
    return offset + position.character
  }
  const document = {
    uri,
    get version() {
      return currentVersion
    },
    get lineCount() {
      return getLines().length
    },
    lineAt: (line: number) => ({ text: getLines()[line] ?? '' }),
    getText: (range?: vscode.Range) =>
      range === undefined ? currentSource : currentSource.slice(offsetAt(range.start), offsetAt(range.end)),
  } as unknown as TextDocument
  const editor = {
    document,
    selection: {
      active: new vscode.Position(1, 10),
      start: new vscode.Position(1, 10),
      end: new vscode.Position(1, 10),
      isEmpty: true,
    },
  } as unknown as TextEditor
  const executeCommand = vi.fn().mockResolvedValue(symbols)
  const workspace = {
    workspaceFolders: [folder],
    textDocuments: [document],
    getWorkspaceFolder: vi.fn(() => folder),
    openTextDocument: vi.fn(() => Promise.resolve(document)),
    fs: {
      stat: vi.fn(() => Promise.resolve({ type: 1, size: Buffer.byteLength(currentSource, 'utf8') })),
    },
  } as unknown as typeof vscode.workspace
  const provider = new EditorContextProvider({
    workspace,
    window: { activeTextEditor: editor } as unknown as typeof vscode.window,
    languages: { getDiagnostics: vi.fn(() => []) } as unknown as typeof vscode.languages,
    commands: { executeCommand } as unknown as typeof vscode.commands,
    now: () => 1_000,
  })
  const owner: EditorContextOwner = {
    ownerId: DSH_CHAT_VIEW_OWNER_ID,
    ownerViewId: DSH_CHAT_VIEW_OWNER_ID,
    workspaceFolderId: workspaceFolderId(folder),
    contextStoreGeneration: 1,
  }

  return {
    document,
    owner,
    executeCommand,
    setDocument: (nextSource, nextVersion) => {
      currentSource = nextSource
      currentVersion = nextVersion
    },
    provider,
  }
}

function range(
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): vscode.Range {
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter)
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('EditorContextProvider', () => {
  it('captures the innermost nested document symbol and keeps it host-side', async () => {
    const harness = createHarness([
      {
        name: 'greet',
        detail: '(name: string)',
        range: range(0, 0, 2, 1),
        children: [{ name: 'return expression', range: range(1, 2, 1, 24), children: [] }],
      },
    ])

    const availability = await harness.provider.availability(harness.owner)
    expect(availability.availableKinds).toContain('symbol')

    const item = await harness.provider.capture({ kind: 'symbol' }, harness.owner)
    expect(item.ref.kind).toBe('symbol')
    expect(item.ref.range).toEqual({
      start: { line: 1, column: 2 },
      end: { line: 1, column: 24 },
    })
    expect(item.label).toContain('return expression')
    expect(Object.keys(item)).toEqual(['ref', 'label', 'stale', 'previewAvailable'])

    const preview = await harness.provider.preview(item.ref.contextRef, harness.owner)
    expect(preview.text).toBe('return `Hello ${name}`')

    const resolved = await harness.provider.resolveForPrompt({
      ...harness.owner,
      sessionId: 'session-1',
      backendInstanceId: 'backend-1',
      connectionGeneration: 1,
      contextRefs: [item.ref.contextRef],
    })
    expect(resolved[0]?.attachment.name).toBe('src/greet.ts')
    expect(Buffer.from(resolved[0]?.attachment.uri.split(',')[1] ?? '', 'base64').toString('utf8')).toBe(
      'return `Hello ${name}`',
    )
    expect(harness.executeCommand).toHaveBeenCalledWith(
      'vscode.executeDocumentSymbolProvider',
      harness.document.uri,
    )
  })

  it('accepts SymbolInformation-shaped provider results for the active document', async () => {
    const harness = createHarness([
      {
        name: 'greet',
        location: { uri: harnessUri(documentPath), range: range(0, 0, 2, 1) },
      },
    ])

    const item = await harness.provider.capture({ kind: 'symbol' }, harness.owner)
    expect(item.label).toContain('greet')
    expect((await harness.provider.preview(item.ref.contextRef, harness.owner)).text).toBe(source)
  })

  it('bounds a composed context label so one item cannot break the feature payload', async () => {
    const harness = createHarness([
      { name: 'n'.repeat(600), detail: '', range: range(0, 0, 2, 1), children: [] },
    ])

    const item = await harness.provider.capture({ kind: 'symbol' }, harness.owner)
    expect(item.label.startsWith('symbol: src/greet.ts:1 ')).toBe(true)
    expect(item.label.length).toBe(512)
  })

  it('fails closed for provider errors and malformed or foreign symbol ranges', async () => {
    const malformed = createHarness([
      { name: 'outside', range: range(99, 0, 99, 1) },
      {
        name: 'foreign',
        location: { uri: harnessUri(path.join(workspaceRoot, 'other.ts')), range: range(0, 0, 1, 1) },
      },
    ])
    expect((await malformed.provider.availability(malformed.owner)).availableKinds).not.toContain('symbol')
    await expect(malformed.provider.capture({ kind: 'symbol' }, malformed.owner)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })

    const providerError = createHarness(undefined)
    providerError.executeCommand.mockRejectedValue(new Error('language service unavailable'))
    expect((await providerError.provider.availability(providerError.owner)).availableKinds).not.toContain(
      'symbol',
    )
    await expect(
      providerError.provider.capture({ kind: 'symbol' }, providerError.owner),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('propagates cancellation while waiting for the language service', async () => {
    const pending = deferred<unknown>()
    const harness = createHarness([])
    harness.executeCommand.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const request = harness.provider.availability(harness.owner, controller.signal)

    await vi.waitFor(() => expect(harness.executeCommand).toHaveBeenCalled())
    controller.abort()
    pending.resolve([])

    await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
  })

  it('marks a captured symbol stale when the document changes before preview', async () => {
    const harness = createHarness([{ name: 'greet', range: range(0, 0, 2, 1) }])
    const item = await harness.provider.capture({ kind: 'symbol' }, harness.owner)
    harness.setDocument(source.replace('greet', 'hello'), 2)

    await expect(harness.provider.preview(item.ref.contextRef, harness.owner)).rejects.toMatchObject({
      code: 'CONTEXT_STALE',
    })
  })
})

function harnessUri(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath)
}
