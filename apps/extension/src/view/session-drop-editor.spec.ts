import { describe, expect, it, vi, type Mock } from 'vitest'
import type * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import {
  SESSION_DROP_EDITOR_VIEW_TYPE,
  sessionEditorResource,
  sessionIdFromEditorResource,
} from '@dsh-vscode/webview-protocol'
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
  it('registers the resource editor association and activation used by native drops', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      activationEvents: unknown
      contributes: { customEditors: unknown }
    }
    expect(manifest.activationEvents).toContain(`onCustomEditor:${SESSION_DROP_EDITOR_VIEW_TYPE}`)
    expect(manifest.contributes.customEditors).toContainEqual({
      viewType: SESSION_DROP_EDITOR_VIEW_TYPE,
      displayName: 'DeepSeek Harness Chat',
      selector: [{ filenamePattern: '*.dsh-chat' }],
      priority: 'default',
    })
  })

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

  it('does not open an already cancelled drop and aborts an in-flight one', async () => {
    const cancelled = harness()
    cancelled.token.isCancellationRequested = true
    await cancelled.resolve()
    expect(cancelled.open).not.toHaveBeenCalled()
    const h = harness()
    h.open.mockImplementation((_sessionId, _column, signal) => {
      h.cancel()
      expect(signal.aborted).toBe(true)
      return Promise.reject(new Error('cancelled'))
    })
    await h.resolve()
    expect(h.report).not.toHaveBeenCalled()
    expect(h.panel.dispose).toHaveBeenCalledOnce()
  })

  it.each(['s1', 'opaque/id?#&= 空间', 'a'.repeat(256)])('round trips an opaque session ID: %s', (id) => {
    expect(sessionIdFromEditorResource(sessionEditorResource(id))).toBe(id)
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
