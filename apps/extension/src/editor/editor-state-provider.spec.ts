import { mkdtemp, writeFile, rm, mkdir, symlink, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { EditorStateProvider } from './editor-state-provider.js'
import { workspaceFolderId } from './workspace-path-guard.js'

const state = vi.hoisted(
  (): { trusted: boolean; editor: unknown; folders: unknown[]; diagnostics: unknown[] } => ({
    trusted: true,
    editor: undefined,
    folders: [],
    diagnostics: [],
  }),
)
vi.mock('vscode', () => ({
  FileType: { File: 1, SymbolicLink: 64 },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
  window: {
    get activeTextEditor() {
      return state.editor
    },
  },
  workspace: {
    get isTrusted() {
      return state.trusted
    },
    get workspaceFolders() {
      return state.folders
    },
    getWorkspaceFolder: () => state.folders[0],
    fs: { stat: async (uri: { fsPath: string }) => ({ type: (await stat(uri.fsPath)).isFile() ? 1 : 2 }) },
  },
  languages: { getDiagnostics: () => state.diagnostics },
}))
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  state.trusted = true
})
async function fixture(): Promise<{ provider: EditorStateProvider; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-state-provider-'))
  roots.push(root)
  const file = path.join(root, 'sample.ts')
  await writeFile(file, 'private source body')
  const folder = { uri: vscode.Uri.file(root), name: 'fixture', index: 0 }
  state.folders = [folder]
  state.editor = {
    document: { uri: vscode.Uri.file(file), languageId: 'typescript', version: 3, isDirty: true },
    selection: { start: { line: 0, character: 2 }, end: { line: 1, character: 4 } },
  }
  state.diagnostics = [{ severity: 0, message: 'private diagnostic body' }, { severity: 1 }]
  return { root, provider: new EditorStateProvider(workspaceFolderId(folder), () => true) }
}
describe('VS Code editor metadata provider', () => {
  it('reports live metadata and cached counts without accessing or returning text', async () => {
    const { provider } = await fixture()
    const result = await provider.read(new AbortController().signal)
    expect(result).toMatchObject({
      relativePath: 'sample.ts',
      dirty: true,
      documentVersion: 3,
      selection: { start: { line: 1, column: 3 }, end: { line: 2, column: 5 } },
      diagnostics: { errors: 1, warnings: 1 },
    })
    expect(JSON.stringify(result)).not.toMatch(/private|fsPath|endpoint|bindingId/u)
  })
  it('rejects trust loss, cancellation and absent editors instead of reporting an empty state', async () => {
    const { provider } = await fixture()
    state.trusted = false
    await expect(provider.read(new AbortController().signal)).rejects.toMatchObject({ reason: 'untrusted' })
    state.trusted = true
    await expect(provider.read(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    state.editor = undefined
    await expect(provider.read(new AbortController().signal)).rejects.toMatchObject({ reason: 'no-editor' })
  })
  it('rejects a directory link escaping the workspace root', async () => {
    const { root, provider } = await fixture()
    const outside = await mkdtemp(path.join(os.tmpdir(), 'editor-state-outside-'))
    roots.push(outside)
    await writeFile(path.join(outside, 'private.ts'), 'private')
    await mkdir(path.join(root, 'nested'))
    await symlink(
      outside,
      path.join(root, 'nested', 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    state.editor = { document: { uri: vscode.Uri.file(path.join(root, 'nested', 'link', 'private.ts')) } }
    await expect(provider.read(new AbortController().signal)).rejects.toMatchObject({
      reason: 'workspace-mismatch',
    })
  })
})
