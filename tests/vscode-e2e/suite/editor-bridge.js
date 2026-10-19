import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as vscode from 'vscode'

export async function run() {
  const bundle = process.env.DSH_EDITOR_STATE_TEST_BUNDLE
  assert.ok(bundle, 'the runner must provide its test-owned metadata-provider bundle')
  const { EditorStateProvider, workspaceFolderId, EditorCompanionProvider, EditLedger } = createRequire(
    import.meta.url,
  )(bundle)
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder)
  const uri = vscode.Uri.joinPath(folder.uri, 'sample.ts')
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('const value = 1\n'))
  const document = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(document)
  editor.selection = new vscode.Selection(0, 6, 0, 11)
  const diagnostics = vscode.languages.createDiagnosticCollection('editor-bridge-fixture')
  let current = true
  const companion = new EditorCompanionProvider(
    [folder],
    ['content', 'diagnostics', 'language', 'navigation', 'edit'],
    () => current,
    new EditLedger(),
  )
  const registrations = [
    vscode.languages.registerDocumentSymbolProvider(
      { scheme: 'file', language: 'typescript' },
      {
        provideDocumentSymbols: () => [
          new vscode.DocumentSymbol(
            'fixtureSymbol',
            '',
            vscode.SymbolKind.Variable,
            new vscode.Range(0, 0, 0, 5),
            new vscode.Range(0, 0, 0, 5),
          ),
        ],
      },
    ),
    vscode.languages.registerDefinitionProvider(
      { scheme: 'file', language: 'typescript' },
      {
        provideDefinition: () => new vscode.Location(uri, new vscode.Range(0, 0, 0, 5)),
      },
    ),
    vscode.languages.registerReferenceProvider(
      { scheme: 'file', language: 'typescript' },
      {
        provideReferences: () => [new vscode.Location(uri, new vscode.Range(0, 0, 0, 5))],
      },
    ),
  ]
  try {
    diagnostics.set(uri, [
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 5),
        'private diagnostic body',
        vscode.DiagnosticSeverity.Error,
      ),
      new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 5),
        'private warning body',
        vscode.DiagnosticSeverity.Warning,
      ),
    ])
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// private unsaved source\n'))
    const provider = new EditorStateProvider(workspaceFolderId(folder), () => true)
    const snapshot = await provider.read(new AbortController().signal)
    assert.equal(snapshot.relativePath, 'sample.ts')
    assert.equal(snapshot.documentVersion, document.version)
    assert.equal(snapshot.dirty, true)
    assert.equal(snapshot.diagnostics.errors, 1)
    assert.equal(snapshot.diagnostics.warnings, 1)
    assert.deepEqual(snapshot.selection.start, {
      line: editor.selection.start.line + 1,
      column: editor.selection.start.character + 1,
    })
    assert.doesNotMatch(JSON.stringify(snapshot), /private|fsPath|bindingId|endpoint/u)
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), '// next version\n'))
    const refreshed = await provider.read(new AbortController().signal)
    assert.ok(refreshed.documentVersion > snapshot.documentVersion)
    await assert.rejects(provider.read(AbortSignal.abort()), { name: 'AbortError' })
    const revoked = new EditorStateProvider(workspaceFolderId(folder), () => false)
    await assert.rejects(revoked.read(new AbortController().signal), { reason: 'workspace-mismatch' })
    const signal = new AbortController().signal
    const read = await companion.execute(
      { kind: 'document', path: 'sample.ts', expectedVersion: document.version },
      signal,
    )
    assert.equal(read.text, document.getText())
    assert.equal(read.dirty, true)
    editor.selection = new vscode.Selection(0, 0, 0, 5)
    assert.equal(
      (await companion.execute({ kind: 'selection' }, signal)).text,
      document.getText(editor.selection),
    )
    const details = await companion.execute({ kind: 'diagnostics', path: 'sample.ts' }, signal)
    assert.equal(details.cached, true)
    assert.ok(details.items.some((item) => item.message === 'private diagnostic body'))
    const symbols = await companion.execute({ kind: 'symbols', path: 'sample.ts' }, signal)
    assert.ok(symbols.items.some((item) => item.name === 'fixtureSymbol'))
    for (const kind of ['definitions', 'references']) {
      const locations = await companion.execute({ kind, path: 'sample.ts', line: 1, column: 1 }, signal)
      assert.ok(locations.items.some((item) => item.relativePath === 'sample.ts'))
    }
    assert.equal(
      (await companion.execute({ kind: 'open', path: 'sample.ts', line: 1, column: 1 }, signal)).kind,
      'opened',
    )
    const original = document.getText()
    const proposal = await companion.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: document.version,
        edits: [
          { range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, text: '// proposed\n' },
        ],
      },
      signal,
    )
    assert.equal(proposal.status, 'applied')
    assert.equal(proposal.saved, true)
    assert.equal(document.getText(), '// proposed\n' + original)
    assert.equal(document.isDirty, false)
    assert.equal(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)), document.getText())
    assert.equal(
      (await companion.execute({ kind: 'proposal', proposalId: proposal.proposalId }, signal)).status,
      'applied',
    )
    // Real VS Code undo, rather than a fixture callback, must restore the edit group.
    await vscode.commands.executeCommand('undo')
    assert.equal(document.getText(), original)
    const next = await companion.execute(
      {
        kind: 'propose',
        path: 'sample.ts',
        expectedVersion: document.version,
        edits: [{ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }, text: '// next\n' }],
      },
      signal,
    )
    assert.equal(next.status, 'applied')
    assert.equal(await companion.proposals.undo(next.proposalId), true)
    assert.equal(document.getText(), original)
    assert.equal(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)),
      original,
      'agent edits and independent revert must save the resulting file',
    )
    const pageUri = vscode.Uri.joinPath(folder.uri, 'pagination.txt')
    const fullText =
      Array.from({ length: 2500 }, (_, index) => `line-${index}\r\n`).join('') + 'x'.repeat(16383) + '😀tail'
    await vscode.workspace.fs.writeFile(pageUri, new TextEncoder().encode(fullText))
    let startLine = 1,
      startColumn = 1,
      restored = ''
    for (let page = 0; page < 25; page++) {
      const value = await companion.execute(
        { kind: 'document', path: 'pagination.txt', startLine, startColumn },
        signal,
      )
      assert.ok(value.text.length <= 16384)
      restored += value.text
      if (!value.truncated) break
      assert.ok(value.text.length > 0)
      startLine = value.range.end.line
      startColumn = value.range.end.column
    }
    assert.equal(
      restored,
      fullText,
      'actual VS Code positions must preserve CRLF and surrogate pairs across pages',
    )
    await vscode.workspace.fs.delete(pageUri)
    await assert.rejects(companion.execute({ kind: 'document', path: 'pagination.txt' }, signal), {
      reason: 'not-found',
    })
    assert.equal((await companion.execute({ kind: 'document', path: 'sample.ts' }, signal)).kind, 'document')
    current = false
    await assert.rejects(companion.execute({ kind: 'document', path: 'sample.ts' }, signal), {
      reason: 'workspace-mismatch',
    })
    console.log(
      '[dsh-editor-vscode] real editor APIs: metadata, unsaved text/selection, cached diagnostics, language providers, navigation, immediate edits, automatic save, native Undo, independent revert and revocation passed; no model inference claimed',
    )
  } finally {
    companion.dispose()
    for (const registration of registrations) registration.dispose()
    diagnostics.dispose()
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  }
}
