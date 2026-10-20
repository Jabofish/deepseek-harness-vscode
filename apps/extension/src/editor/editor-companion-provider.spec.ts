import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { EditorCompanionProvider } from './editor-companion-provider.js'
import {
  isEditorCompanionValue,
  type EditorCompanionRepository,
  type EditorCompanionResult,
} from '@dsh-vscode/domain'
import { EditorCompanionService } from '@dsh-vscode/application'
import { EditorCompanionBroker } from '../../../../packages/dsh-editor-bridge/src/companion-broker.js'
import { EditLedger } from './edit-ledger.js'
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
  ledger: EditLedger
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
  const ledger = new EditLedger()
  const provider = new EditorCompanionProvider(
    [folder],
    ['content', 'diagnostics', 'language', 'navigation', 'edit'],
    () => state.current,
    ledger,
  )
  providers.push(provider)
  return { root, file, folder, document, ledger, provider }
}
const signal = (): AbortSignal => new AbortController().signal
describe('granted editor operations', () => {
  it.each(['exact', 'user-changed', 'not-written'] as const)(
    'retains an undo record after an ambiguous native %s reply',
    async (outcome) => {
      const { provider, document, file, ledger } = await fixture()
      const apply = native.applyEdit.getMockImplementation()!
      native.applyEdit.mockImplementationOnce(async (edit) => {
        if (outcome !== 'not-written') await apply(edit)
        if (outcome === 'user-changed') {
          document.text += '// user draft\n'
          document.version += 1
        }
        throw new Error('Native reply lost')
      })
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
      expect(receipt).toMatchObject({ status: outcome === 'exact' ? 'applied' : 'uncertain', saved: false })
      expect(isEditorCompanionValue(receipt)).toBe(true)
      expect(ledger.lastApplied()?.before).toBe('const value = 2\n')
      expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
      expect(document.text).toBe(`const value = 2\n${outcome === 'user-changed' ? '// user draft\n' : ''}`)
      expect(document.save).not.toHaveBeenCalled()
      expect(await readFile(file, 'utf8')).toBe('const value = 1\n')
    },
  )

  it('applies and undoes an edit without saving a pre-existing dirty buffer', async () => {
    const { provider, document, file } = await fixture()
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
    expect(receipt).toMatchObject({ status: 'applied', saved: false })
    expect(document.text).toBe('let value = 2\n')
    expect(document.isDirty).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('const value = 1\n')
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\n')
    expect(document.isDirty).toBe(true)
    expect(document.save).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('const value = 1\n')
  })

  it('does not save user changes made while the native apply was pending', async () => {
    const { provider, document, file } = await fixture()
    await document.save()
    document.save.mockClear()
    const apply = native.applyEdit.getMockImplementation()!
    native.applyEdit.mockImplementationOnce(async (edit) => {
      const applied = await apply(edit)
      document.text += '// user is still typing\n'
      document.version += 1
      document.isDirty = true
      return applied
    })
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }],
      },
      signal(),
    )
    expect(receipt).toMatchObject({ status: 'applied', saved: false })
    expect(document.save).not.toHaveBeenCalled()
    expect(document.text).toContain('// user is still typing')
    expect(await readFile(file, 'utf8')).toBe('const value = 2\n')
  })

  it('does not save unrelated user changes when undoing an already saved agent edit', async () => {
    const { provider, document, file } = await fixture()
    await document.save()
    document.save.mockClear()
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
    expect(receipt).toMatchObject({ saved: true })
    document.text += '// user draft\n'
    document.version += 1
    document.isDirty = true
    document.save.mockClear()
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\n// user draft\n')
    expect(document.isDirty).toBe(true)
    expect(document.save).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('let value = 2\n')
  })

  it('returns applied/saved through both reply validators, retrieves the receipt and keeps access after a missing file', async () => {
    const { provider, document, file, root } = await fixture()
    await document.save()
    document.save.mockClear()
    const broker = new EditorCompanionBroker()
    const unwrap = <T>(reply: EditorCompanionResult<T>): T => {
      if (reply.status !== 'ok') throw new Error(reply.reason)
      return reply.value
    }
    const repository: EditorCompanionRepository = {
      describe: () =>
        Promise.resolve({
          protocolVersion: 2,
          packageVersion: '0.2.0',
          maxGrants: 16,
          capabilities: ['content', 'edit'],
        }),
      verifyHost: () => Promise.resolve({ proof: 'a'.repeat(64) }),
      attach: (session, owner, capabilities) =>
        Promise.resolve(unwrap(broker.attach(session, owner, 'peer', capabilities))),
      poll: async (binding, abort) => unwrap(await broker.poll(binding, 'peer', abort ?? signal())),
      respond: (binding, id, reply) =>
        Promise.resolve().then(() => {
          unwrap(broker.respond(binding, 'peer', id, reply))
        }),
      detach: (binding) =>
        Promise.resolve().then(() => {
          unwrap(broker.detach(binding, 'peer'))
        }),
    }
    const service = new EditorCompanionService()
    try {
      await service.start(repository, 'session', 'owner', ['content', 'edit'], provider)
      const receipt = await broker.read(
        'session',
        {
          kind: 'propose',
          path: 'sample.ts',
          expectedVersion: 1,
          edits: [
            {
              range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
              text: '// inserted once\n',
            },
          ],
        },
        signal(),
      )
      if (receipt.kind !== 'proposal') throw new Error('Missing edit receipt')
      expect(receipt).toMatchObject({ status: 'applied', version: 2, saved: true })
      expect(document.save).toHaveBeenCalledTimes(1)
      expect(document.isDirty).toBe(false)
      expect(await readFile(file, 'utf8')).toBe('// inserted once\nconst value = 2\n')
      expect(
        await broker.read('session', { kind: 'proposal', proposalId: receipt.proposalId }, signal()),
      ).toEqual(receipt)
      await expect(
        broker.read('session', { kind: 'proposal', proposalId: 'unknown_receipt_1234' }, signal()),
      ).rejects.toMatchObject({ reason: 'not-found' })
      const deleted = path.join(root, 'deleted.ts')
      await writeFile(deleted, 'deleted')
      await rm(deleted)
      await expect(
        broker.read('session', { kind: 'document', path: 'deleted.ts' }, signal()),
      ).rejects.toMatchObject({ reason: 'not-found' })
      expect(service.active).toBe(true)
      expect((await broker.read('session', { kind: 'document' }, signal())).kind).toBe('document')
      await provider.proposals.undo(receipt.proposalId)
      expect(await readFile(file, 'utf8')).toBe('const value = 2\n')
    } finally {
      await service.stop()
      broker.dispose()
    }
  })
  it('reports an applied buffer edit when saving fails, and ignores failures of the optional edit indicator', async () => {
    const { provider, document, file, folder, ledger } = await fixture()
    await document.save()
    document.save.mockClear()
    document.save.mockRejectedValueOnce(new Error('save denied'))
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [
          { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, text: '// retained\n' },
        ],
      },
      signal(),
    )
    expect(receipt).toMatchObject({ status: 'applied', saved: false, version: 2 })
    expect(document.text).toContain('// retained')
    expect(document.isDirty).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('const value = 2\n')
    const indicator = new EditorCompanionProvider(
      [folder],
      ['edit'],
      () => true,
      ledger,
      () => {
        throw new Error('UI failure')
      },
    )
    providers.push(indicator)
    expect(
      await indicator.execute(
        {
          kind: 'propose',
          path: 'sample.ts',
          expectedVersion: 2,
          edits: [
            { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, text: '// next\n' },
          ],
        },
        signal(),
      ),
    ).toMatchObject({ status: 'applied', saved: false, version: 3 })
  })
  it('paginates documents and long lines without losing CRLF or surrogate pairs, and refuses starts past EOF', async () => {
    const { provider, document } = await fixture()
    for (const text of [
      Array.from({ length: 2500 }, (_, i) => `line-${i}\r\n`).join(''),
      'x'.repeat(16383) + '😀tail',
    ]) {
      document.text = text
      let line = 1,
        column = 1,
        combined = ''
      for (let page = 0; page < 25; page++) {
        const value = await provider.execute(
          { kind: 'document', startLine: line, startColumn: column, expectedVersion: document.version },
          signal(),
        )
        if (value.kind !== 'document') throw new Error('Missing document')
        expect(value.text.length).toBeLessThanOrEqual(16384)
        expect(value.range.end.line - value.range.start.line).toBeLessThan(200)
        combined += value.text
        if (!value.truncated) break
        expect(value.text.length).toBeGreaterThan(0)
        line = value.range.end.line
        column = value.range.end.column
      }
      expect(combined).toBe(text)
    }
    document.text = 'one'
    await expect(
      provider.execute({ kind: 'document', startLine: 50, endLine: 80 }, signal()),
    ).rejects.toMatchObject({ reason: 'invalid-range' })
    await expect(provider.execute({ kind: 'document', startColumn: 99 }, signal())).rejects.toMatchObject({
      reason: 'invalid-range',
    })
    expect(await provider.execute({ kind: 'open' }, signal())).toEqual({
      kind: 'opened',
      relativePath: 'sample.ts',
    })
  })
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
      text: 'x'.repeat(16_384),
      truncated: true,
      range: { end: { line: 1, column: 16_385 } },
    })
  })
  it('clamps line ranges and returns empty selection text instead of failing', async () => {
    const { provider, document } = await fixture()
    document.text = 'one\ntwo\nthree\n'
    expect(await provider.execute({ kind: 'document', startLine: 0, endLine: 999 }, signal())).toMatchObject({
      text: 'one\ntwo\nthree\n',
    })
    expect(await provider.execute({ kind: 'document', startLine: 3, endLine: 1 }, signal())).toMatchObject({
      text: 'three',
      range: { start: { line: 3, column: 1 } },
    })
    const editor = state.editor
    if (editor === undefined) throw new Error('fixture editor is missing')
    editor.selection = new FixtureRange(1, 0, 1, 0)
    expect(await provider.execute({ kind: 'selection' }, signal())).toMatchObject({ text: '' })
  })
  it('enforces permissions and revocation before reading source, and metadata does not read text', async () => {
    const { provider, folder, document } = await fixture()
    const metadata = new EditorCompanionProvider([folder], [], () => state.current, new EditLedger())
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
  it('applies an undoable edit immediately and saves the file', async () => {
    const { provider, document, file } = await fixture()
    await document.save()
    document.save.mockClear()
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
    expect(receipt).toMatchObject({ kind: 'proposal', status: 'applied' })
    expect(document.text).toBe('const value = 3\n')
    expect(native.applyEdit).toHaveBeenCalledTimes(1)
    expect(await readFile(file, 'utf8')).toBe('const value = 3\n')
    expect(document.isDirty).toBe(false)
    // No notification: the host shows a transient status bar entry instead.
    expect(native.info).not.toHaveBeenCalled()
    if (receipt.kind !== 'proposal') throw new Error('Missing proposal')
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\n')
    expect(provider.proposals.get(receipt.proposalId)).toMatchObject({ status: 'reverted' })
  })
  it('rejects overlapping edits and refuses to revert a buffer the user changed', async () => {
    const { provider, document } = await fixture()
    const edit = { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }
    await expect(
      provider.execute(
        { kind: 'propose', path: 'sample.ts', expectedVersion: 1, edits: [edit, edit] },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-response' })
    await expect(
      provider.execute({ kind: 'propose', path: 'sample.ts', expectedVersion: 1, edits: [edit] }, signal()),
    ).resolves.toMatchObject({ status: 'applied' })
    expect(document.text).toBe('let value = 2\n')
    const next = await provider.execute(
      { kind: 'propose', path: 'sample.ts', expectedVersion: 2, edits: [edit] },
      signal(),
    )
    if (next.kind !== 'proposal') throw new Error('Missing proposal')
    document.text = 'user changed this'
    document.version += 1
    expect(await provider.proposals.undo(next.proposalId)).toBe(false)
    expect(provider.proposals.get(next.proposalId)).toMatchObject({ status: 'applied' })
    expect(document.text).toBe('user changed this')
  })
  it('keeps an applied edit undoable after the grant ends and a new session starts', async () => {
    const { provider, document, folder, ledger } = await fixture()
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }],
      },
      signal(),
    )
    expect(receipt).toMatchObject({ status: 'applied' })
    if (receipt.kind !== 'proposal') throw new Error('Missing proposal')
    provider.dispose()
    // A revoked grant cannot revert, but the record itself survives revocation.
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(false)
    expect(provider.proposals.get(receipt.proposalId)).toMatchObject({ status: 'applied' })
    const next = new EditorCompanionProvider(
      [folder],
      ['content', 'diagnostics', 'language', 'navigation', 'edit'],
      () => state.current,
      ledger,
    )
    providers.push(next)
    expect(await next.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\n')
    expect(next.proposals.get(receipt.proposalId)).toMatchObject({ status: 'reverted' })
  })
  it('shares every workspace root and prefixes paths with the root name', async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'editor-multi-a-'))
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'editor-multi-b-'))
    roots.push(firstRoot, secondRoot)
    await writeFile(path.join(firstRoot, 'app.ts'), 'export const app = 1\n')
    await writeFile(path.join(secondRoot, 'lib.ts'), 'export const lib = 2\n')
    const appFolder = {
      uri: FixtureUri.file(firstRoot),
      name: 'app',
      index: 0,
    } as unknown as vscode.WorkspaceFolder
    const libFolder = {
      uri: FixtureUri.file(secondRoot),
      name: 'lib',
      index: 1,
    } as unknown as vscode.WorkspaceFolder
    state.folders.push(appFolder, libFolder)
    const appDocument = new FixtureDocument(
      FixtureUri.file(path.join(firstRoot, 'app.ts')),
      'export const app = 1\n',
    )
    const libDocument = new FixtureDocument(
      FixtureUri.file(path.join(secondRoot, 'lib.ts')),
      'export const lib = 2\n',
    )
    state.documents.set(appDocument.uri.toString(), appDocument)
    state.documents.set(libDocument.uri.toString(), libDocument)
    state.editor = new FixtureEditor(libDocument)
    const provider = new EditorCompanionProvider(
      [appFolder, libFolder],
      ['content', 'diagnostics', 'language', 'navigation', 'edit'],
      () => state.current,
      new EditLedger(),
    )
    providers.push(provider)
    expect(await provider.execute({ kind: 'document' }, signal())).toMatchObject({
      relativePath: 'lib/lib.ts',
    })
    expect(await provider.execute({ kind: 'document', path: 'app/app.ts' }, signal())).toMatchObject({
      relativePath: 'app/app.ts',
      text: 'export const app = 1\n',
    })
    await expect(provider.execute({ kind: 'document', path: 'app.ts' }, signal())).rejects.toMatchObject({
      reason: 'workspace-mismatch',
    })
    expect(
      await provider.execute(
        {
          kind: 'propose',
          path: 'app/app.ts',
          expectedVersion: 1,
          edits: [{ range: { start: { line: 1, column: 14 }, end: { line: 1, column: 17 } }, text: 'lib' }],
        },
        signal(),
      ),
    ).toMatchObject({ status: 'applied' })
    expect(appDocument.text).toBe('export const lib = 1\n')
  })
  it('reads the active untitled buffer and refuses to edit it', async () => {
    const { provider } = await fixture()
    const untitled = new FixtureDocument(new FixtureUri('Untitled-1', 'untitled'), 'draft\n')
    state.editor = new FixtureEditor(untitled)
    const draft = await provider.execute({ kind: 'document' }, signal())
    expect(isEditorCompanionValue(draft)).toBe(true)
    expect(draft).toMatchObject({
      relativePath: expect.stringMatching(/^__dsh_drafts__\//u) as unknown,
      text: 'draft\n',
    })
    expect(await provider.execute({ kind: 'selection' }, signal())).toMatchObject({
      relativePath: 'relativePath' in draft ? draft.relativePath : '',
      text: 'draft',
    })
    // The wire schema refuses the label before it reaches the workspace: there is no write path.
    await expect(
      provider.execute(
        {
          kind: 'propose',
          path: 'untitled:Untitled-1',
          expectedVersion: 1,
          edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'final' }],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('reverts only the agent span when the user edited elsewhere', async () => {
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
    document.text += 'const extra = 9\n'
    document.version += 1
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\nconst extra = 9\n')
  })
  it('rebases an edit when the user kept typing elsewhere in the file', async () => {
    const { provider, document } = await fixture()
    await provider.execute({ kind: 'document' }, signal())
    document.text = '// header\n' + document.text
    document.version += 1
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }],
      },
      signal(),
    )
    expect(receipt).toMatchObject({ status: 'applied' })
    expect(document.text).toBe('// header\nlet value = 2\n')
  })
  it('refuses an edit that overlaps the span the user just changed', async () => {
    const { provider, document } = await fixture()
    await provider.execute({ kind: 'document' }, signal())
    document.text = 'var value = 2\n'
    document.version += 1
    await expect(
      provider.execute(
        {
          kind: 'propose',
          path: 'sample.ts',
          expectedVersion: 1,
          edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } }, text: 'let' }],
        },
        signal(),
      ),
    ).rejects.toMatchObject({ reason: 'stale-document' })
    expect(document.text).toBe('var value = 2\n')
  })
  it('locates a short repeated span by widening the context', async () => {
    const { provider, document } = await fixture()
    document.text = 'a = 1\nb = 2\n'
    const receipt = await provider.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: 1,
        edits: [{ range: { start: { line: 1, column: 5 }, end: { line: 1, column: 6 } }, text: '2' }],
      },
      signal(),
    )
    if (receipt.kind !== 'proposal') throw new Error('Missing proposal')
    document.text += '// 2\n'
    document.version += 1
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('a = 1\nb = 2\n// 2\n')
  })
  it('reverts by text match after a save bumps the document version', async () => {
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
    document.version += 7
    expect(await provider.proposals.undo(receipt.proposalId)).toBe(true)
    expect(document.text).toBe('const value = 2\n')
  })
})
