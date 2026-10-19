import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { EditorCompanionProvider } from './editor-companion-provider.js'
import {
  FixtureDocument,
  FixtureEditor,
  FixtureRange,
  FixtureUri,
  native,
  resetCompanionFixture,
  state,
} from './test-fixtures/companion-vscode.js'
vi.mock('vscode', async () =>
  (await import('./test-fixtures/companion-vscode.js')).createCompanionVscodeApi(),
)
const roots: string[] = []
const providers: EditorCompanionProvider[] = []
beforeEach(resetCompanionFixture)
afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{
  root: string
  file: string
  folder: vscode.WorkspaceFolder
  document: FixtureDocument
  provider: EditorCompanionProvider
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-companion-test-'))
  roots.push(root)
  const file = path.join(root, 'sample.ts')
  await writeFile(file, 'const value = 1\n')
  const folder = {
    uri: FixtureUri.file(root),
    name: 'fixture',
    index: state.folders.length,
  } as unknown as vscode.WorkspaceFolder
  state.folders.push(folder)
  const document = new FixtureDocument(FixtureUri.file(file), 'const value = 2\n')
  state.documents.set(document.uri.toString(), document)
  state.editor = new FixtureEditor(document)
  const provider = new EditorCompanionProvider(
    folder,
    ['content', 'diagnostics', 'language', 'navigation', 'edit'],
    () => state.current,
  )
  providers.push(provider)
  return { root, file, folder, document, provider }
}
const signal = (): AbortSignal => new AbortController().signal
describe('granted editor operations', () => {
  it('reads live unsaved buffers and selections with bounds, versions and matching ranges', async () => {
    const { provider, document } = await fixture()
    expect(await provider.execute({ kind: 'document' }, signal())).toMatchObject({
      text: 'const value = 2\n',
      dirty: true,
      version: 1,
    })
    expect(await provider.execute({ kind: 'selection' }, signal())).toMatchObject({
      text: 'const',
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
    })
    await expect(provider.execute({ kind: 'document', expectedVersion: 2 }, signal())).rejects.toMatchObject({
      reason: 'stale-document',
    })
    document.text = 'x'.repeat(100_000)
    expect(await provider.execute({ kind: 'document' }, signal())).toMatchObject({
      text: 'x'.repeat(65_536),
      truncated: true,
      range: { end: { line: 1, column: 65_537 } },
    })
  })
  it('enforces permissions and revocation before reading source, and metadata does not read text', async () => {
    const { provider, folder, document } = await fixture()
    const metadata = new EditorCompanionProvider(folder, [], () => state.current)
    providers.push(metadata)
    const text = vi.spyOn(document, 'getText')
    expect(await metadata.execute({ kind: 'state' }, signal())).toMatchObject({ kind: 'state' })
    expect(text).not.toHaveBeenCalled()
    await expect(metadata.execute({ kind: 'document' }, signal())).rejects.toMatchObject({ reason: 'denied' })
    state.trusted = false
    await expect(provider.execute({ kind: 'document' }, signal())).rejects.toMatchObject({
      reason: 'untrusted',
    })
    state.trusted = true
    state.current = false
    await expect(provider.execute({ kind: 'document' }, signal())).rejects.toMatchObject({
      reason: 'workspace-mismatch',
    })
    await expect(provider.execute({ kind: 'document' }, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
  it('returns bounded cached diagnostic details and language results scoped to one root in a multi-root window', async () => {
    const first = await fixture()
    const second = await fixture()
    state.editor = new FixtureEditor(first.document)
    state.diagnostics = [
      {
        range: new FixtureRange(0, 0, 0, 5),
        severity: 0,
        message: 'fixture problem',
        source: 'fixture',
        code: { value: 123 },
      },
    ]
    expect(await first.provider.execute({ kind: 'diagnostics' }, signal())).toMatchObject({
      cached: true,
      items: [{ message: 'fixture problem', code: '123' }],
    })
    state.handlers.set('vscode.executeDefinitionProvider', () => [
      { uri: first.document.uri, range: new FixtureRange(0, 0, 0, 5) },
      { uri: second.document.uri, range: new FixtureRange(0, 0, 0, 5) },
    ])
    expect(await first.provider.execute({ kind: 'definitions', line: 1, column: 1 }, signal())).toMatchObject(
      { kind: 'locations', items: [{ relativePath: 'sample.ts' }], excluded: 1 },
    )
    state.handlers.set('vscode.executeDocumentSymbolProvider', () => [
      { name: 'value', kind: 12, range: new FixtureRange(0, 0, 0, 5), children: [] },
    ])
    expect(await first.provider.execute({ kind: 'symbols' }, signal())).toMatchObject({
      items: [{ name: 'value', relativePath: 'sample.ts' }],
    })
    state.editor = undefined
    state.handlers.set('vscode.executeWorkspaceSymbolProvider', () => [
      { name: 'value', kind: 12, location: { uri: first.document.uri, range: new FixtureRange(0, 0, 0, 5) } },
    ])
    expect(await first.provider.execute({ kind: 'symbols', query: 'value' }, signal())).toMatchObject({
      items: [{ name: 'value' }],
    })
    state.editor = new FixtureEditor(first.document)
    state.handlers.set('vscode.executeReferenceProvider', () => {
      first.document.version += 1
      return []
    })
    await expect(
      first.provider.execute({ kind: 'references', line: 1, column: 1 }, signal()),
    ).rejects.toMatchObject({ reason: 'stale-document' })
  })
  it('rejects directory-link escapes and unavailable providers without invoking arbitrary commands', async () => {
    const first = await fixture()
    const second = await fixture()
    await symlink(
      second.root,
      path.join(first.root, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(
      first.provider.execute({ kind: 'document', path: 'escape/sample.ts' }, signal()),
    ).rejects.toMatchObject({ reason: 'workspace-mismatch' })
    state.editor = new FixtureEditor(first.document)
    await expect(
      first.provider.execute({ kind: 'references', line: 1, column: 1 }, signal()),
    ).rejects.toMatchObject({ reason: 'unsupported' })
    expect(native.execute.mock.calls.map((call) => call[0])).toEqual(['vscode.executeReferenceProvider'])
  })
  it('keeps proposals pending until native review and applies an undoable edit without saving', async () => {
    const { provider, document, file } = await fixture()
    await expect(
      provider.execute(
        {
          kind: 'propose',
          path: 'sample.ts',
          expectedVersion: 1,
          edits: [{ range: { start: { line: 1, column: 15 }, end: { line: 1, column: 17 } }, text: '3' }],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'stale-document' })
    // The exact end column is checked: stale coordinates must never be clamped into an edit.
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 15 }, end: { line: 1, column: 16 } }, text: '3' }],
      },
      signal(),
    )
    expect(receipt.kind).toBe('proposal')
    if (receipt.kind !== 'proposal') throw new Error('Missing proposal')
    expect(document.version).toBe(1)
    expect(
      await provider.execute({ kind: 'proposal', proposalId: receipt.proposalId }, signal()),
    ).toMatchObject({ status: 'pending' })
    native.warning.mockResolvedValue('Apply')
    await provider.proposals.review(receipt.proposalId)
    expect(native.warning).toHaveBeenCalledWith(expect.any(String), { modal: false }, 'Apply', 'Decline')
    expect(provider.proposals.get(receipt.proposalId)).toMatchObject({ status: 'applied', version: 2 })
    expect(document.text).toBe('const value = 3\n')
    expect(state.editor?.edit).toHaveBeenCalledWith(expect.any(Function), {
      undoStopBefore: true,
      undoStopAfter: true,
    })
    expect(await readFile(file, 'utf8')).toBe('const value = 1\n')
  })
  it('declines edits, rejects overlap, and prevents a proposal from overwriting a newer buffer', async () => {
    const { provider, document } = await fixture()
    const edit = { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }
    await expect(
      provider.execute(
        { kind: 'propose', path: 'sample.ts', expectedVersion: 1, edits: [edit, edit] },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-response' })
    const first = await provider.execute(
      { kind: 'propose', path: 'sample.ts', expectedVersion: 1, edits: [edit] },
      signal(),
    )
    if (first.kind !== 'proposal') throw new Error('Missing proposal')
    await provider.proposals.review(first.proposalId)
    expect(provider.proposals.get(first.proposalId)).toMatchObject({ status: 'declined' })
    const next = await provider.execute(
      { kind: 'propose', path: 'sample.ts', expectedVersion: 1, edits: [edit] },
      signal(),
    )
    if (next.kind !== 'proposal') throw new Error('Missing proposal')
    native.warning.mockImplementation(() => {
      document.version += 1
      document.text = 'user changed this'
      return Promise.resolve('Apply')
    })
    await provider.proposals.review(next.proposalId)
    expect(provider.proposals.get(next.proposalId)).toMatchObject({ status: 'stale' })
    expect(document.text).toBe('user changed this')
  })
  it('invalidates pending proposals when access is revoked during native confirmation', async () => {
    const { provider, document } = await fixture()
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }],
      },
      signal(),
    )
    if (receipt.kind !== 'proposal') throw new Error('Missing proposal')
    native.warning.mockImplementation(() => {
      provider.dispose()
      return Promise.resolve('Apply')
    })
    await provider.proposals.review(receipt.proposalId)
    expect(document.version).toBe(1)
    expect(document.text).toBe('const value = 2\n')
    expect(provider.proposals.pending()).toEqual([])
  })
})
