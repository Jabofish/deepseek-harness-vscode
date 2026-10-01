import * as vscode from 'vscode'
import { webviewEnvelopeSchema } from '@dsh-vscode/webview-protocol'

import { VIEW_ID } from '../constants.js'
import { createWebviewHtml } from './webview-html.js'

export interface DshWebviewDependencies {
  readonly extensionUri: vscode.Uri
  readonly onMessage: (message: unknown) => Promise<void>
  /** Observe a rejected Webview message task; event callbacks cannot await it. */
  readonly onMessageError?: (error: unknown) => void
  /** Clear view-owned resources before a view is recreated or disposed. */
  readonly onViewDisposed?: () => void
}

export class DshWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = VIEW_ID
  private view: vscode.WebviewView | undefined
  private ready = false
  private readonly readinessWaiters = new Set<(ready: boolean) => void>()
  private readonly disposables: vscode.Disposable[] = []

  public constructor(private readonly dependencies: DshWebviewDependencies) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    if (this.view !== undefined) this.finishReadinessWait(false)
    this.ready = false
    this.disposeViewListeners()
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.dependencies.extensionUri, 'media')],
    }
    webviewView.webview.html = createWebviewHtml(
      webviewView.webview,
      this.dependencies.extensionUri,
      vscode.env.language,
    )
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        // VS Code does not await message listeners. Assimilate both a
        // synchronous throw and a rejected task so a failed response cannot
        // become an unhandled Promise rejection.
        void Promise.resolve()
          .then(() => {
            if (this.view !== webviewView) return
            const parsed = webviewEnvelopeSchema.safeParse(message)
            if (parsed.success && parsed.data.message.type === 'app.ready') {
              this.ready = true
              this.finishReadinessWait(true)
            }
            return this.dependencies.onMessage(message)
          })
          .catch((error: unknown) => {
            try {
              this.dependencies.onMessageError?.(error)
            } catch {
              // Error reporting must not escape the VS Code event callback.
            }
          })
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined
          this.ready = false
          this.finishReadinessWait(false)
        }
        this.disposeViewListeners()
      }),
    )
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.view === undefined || !this.ready
      ? Promise.resolve(false)
      : this.view.webview.postMessage(message)
  }

  /** A resolved view may still be loading its client script. */
  public waitUntilReady(timeoutMs = 10_000): Promise<boolean> {
    if (this.ready && this.view !== undefined) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (ready: boolean): void => {
        clearTimeout(timer)
        this.readinessWaiters.delete(finish)
        resolve(ready)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.readinessWaiters.add(finish)
    })
  }

  private finishReadinessWait(ready: boolean): void {
    for (const finish of [...this.readinessWaiters]) finish(ready)
  }

  public reveal(preserveFocus = true): Promise<void> {
    this.view?.show(preserveFocus)
    return Promise.resolve()
  }

  public dispose(): void {
    this.ready = false
    this.finishReadinessWait(false)
    this.disposeViewListeners()
    this.view = undefined
  }

  private disposeViewListeners(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose()
    this.dependencies.onViewDisposed?.()
  }
}
