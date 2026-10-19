import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as vscode from 'vscode'

export async function run() {
  const bundle = process.env.DSH_EDITOR_STATE_TEST_BUNDLE
  assert.ok(bundle, 'the runner must provide its test-owned metadata-provider bundle')
  const { EditorStateProvider, workspaceFolderId } = createRequire(import.meta.url)(bundle)
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder)
  const uri = vscode.Uri.joinPath(folder.uri, 'sample.ts')
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('const value = 1\n'))
  const document = await vscode.workspace.openTextDocument(uri)
  const editor = await vscode.window.showTextDocument(document)
  editor.selection = new vscode.Selection(0, 6, 0, 11)
  const diagnostics = vscode.languages.createDiagnosticCollection('editor-bridge-fixture')
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
    console.log(
      '[dsh-editor-vscode] real editor, unsaved document, live version, selection, diagnostic counts, metadata allowlist, cancellation and revoked grant passed',
    )
  } finally {
    diagnostics.dispose()
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
  }
}
