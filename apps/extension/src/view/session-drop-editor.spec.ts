import { describe, expect, it, vi, type Mock } from 'vitest'
import type * as vscode from 'vscode'

import { sessionEditorResource, sessionIdFromEditorResource } from '@dsh-vscode/webview-protocol'
import { createSessionDropEditorProvider } from './session-drop-editor.js'

type OpenSession = (
  sessionId: string,
  column: vscode.ViewColumn | undefined,
  signal: AbortSignal,
) => Promise<void>
interface DropHarness {
  readonly provider: ReturnType<typeof createSessionDropEditorProvider>
  readonly open: Mock<OpenSession>
  readonly report: Mock
  readonly panel: { readonly viewColumn: number; readonly dispose: Mock }
  readonly token: {
    isCancellationRequested: boolean
    readonly onCancellationRequested: vscode.Event<unknown>
  }
  readonly resolve: () => Promise<void>
  readonly cancel: () => void
}

function harness(open = vi.fn<OpenSession>().mockResolvedValue(undefined)): DropHarness {
  const report = vi.fn()
  const provider = createSessionDropEditorProvider(open, report)
  const panel = {
    viewColumn: 2,
    dispose: vi.fn(),
    onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  }
  let cancel = (): void => undefined
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: (event: unknown) => unknown) => {
      cancel = () => {
        listener(undefined)
      }
      return { dispose: vi.fn() }
    },
  }
  const uri = { toString: () => sessionEditorResource('s1') }
  const resolve = async (): Promise<void> => {
    const document = await provider.openCustomDocument(
      uri as vscode.Uri,
      { backupId: undefined, untitledDocumentData: undefined },
      token,
    )
    await provider.resolveCustomEditor(document, panel as unknown as vscode.WebviewPanel, token)
  }
  return { provider, open, report, panel, token, resolve, cancel: () => cancel() }
}

describe('native session editor drop', () => {
  it('opens the accepted session in the drop group and releases the temporary editor', async () => {
    const h = harness()
    await h.resolve()
    expect(h.open).toHaveBeenCalledWith('s1', 2, expect.any(AbortSignal))
    expect(h.panel.dispose).toHaveBeenCalledOnce()
    expect(h.report).not.toHaveBeenCalled()
  })

  it('reports a failed open and still releases the temporary editor', async () => {
    const h = harness(vi.fn().mockRejectedValue(new Error('not owned')))
    await h.resolve()
    expect(h.report).toHaveBeenCalledOnce()
    expect(h.panel.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    'file:///tmp/anything.dsh-chat',
    'dsh-session://foreign/czE.dsh-chat',
    'dsh-session:/czE.dsh-chat?sessionId=other',
    'dsh-session:/czE.dsh-chat#other',
    'dsh-session:/../czE.dsh-chat',
    'dsh-session:/_w.dsh-chat',
    'dsh-session:/AA.dsh-chat',
    'dsh-session:/===.dsh-chat',
  ])('rejects a foreign or malformed resource: %s', (resource) => {
    expect(sessionIdFromEditorResource(resource)).toBeUndefined()
    const h = harness()
    expect(() =>
      h.provider.openCustomDocument(
        { toString: () => resource } as vscode.Uri,
        { backupId: undefined, untitledDocumentData: undefined },
        h.token,
      ),
    ).toThrow()
    expect(h.open).not.toHaveBeenCalled()
  })
})
