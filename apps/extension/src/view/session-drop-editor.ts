import type * as vscode from 'vscode'
import { sessionIdFromEditorResource } from '@dsh-vscode/webview-protocol'

interface SessionDropDocument extends vscode.CustomDocument {
  readonly sessionId: string
}

/**
 * VS Code accepts a resource drop before invoking this provider. Hand that
 * accepted drop to the existing panel manager, then release the temporary
 * resource editor. Chat state, restoration and new-session binding stay with
 * the ordinary panels; no file, second chat model or renderer is retained.
 */
export function createSessionDropEditorProvider(
  open: (sessionId: string, column: vscode.ViewColumn | undefined, signal: AbortSignal) => Promise<void>,
  reportFailure: () => void,
): vscode.CustomReadonlyEditorProvider<SessionDropDocument> {
  return {
    openCustomDocument: (uri) => {
      const sessionId = sessionIdFromEditorResource(uri.toString())
      if (sessionId === undefined) throw new Error('This resource is not a chat session.')
      return { uri, sessionId, dispose: () => undefined }
    },
    resolveCustomEditor: async (document, panel, token) => {
      const abort = new AbortController()
      const cancellation = token.onCancellationRequested(() => abort.abort())
      const closed = panel.onDidDispose(() => abort.abort())
      try {
        if (token.isCancellationRequested) return
        await open(document.sessionId, panel.viewColumn, abort.signal)
      } catch {
        if (!abort.signal.aborted) reportFailure()
      } finally {
        cancellation.dispose()
        closed.dispose()
        panel.dispose()
      }
    },
  }
}
