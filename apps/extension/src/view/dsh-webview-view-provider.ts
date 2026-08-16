import * as vscode from 'vscode'

import { VIEW_ID } from '../constants.js'
import { createWebviewHtml } from './webview-html.js'

export interface DshWebviewDependencies {
  readonly extensionUri: vscode.Uri
  readonly onMessage: (message: unknown) => Promise<void>
}

export class DshWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = VIEW_ID
  private view: vscode.WebviewView | undefined
  private readonly disposables: vscode.Disposable[] = []

  public constructor(private readonly dependencies: DshWebviewDependencies) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewListeners()
    this.view = webviewView
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.dependencies.extensionUri, 'media')],
    }
    webviewView.webview.html = createWebviewHtml(webviewView.webview, this.dependencies.extensionUri)
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        void this.dependencies.onMessage(message)
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) this.view = undefined
        this.disposeViewListeners()
      }),
    )
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.view === undefined ? Promise.resolve(false) : this.view.webview.postMessage(message)
  }

  public reveal(preserveFocus = true): Promise<void> {
    this.view?.show(preserveFocus)
    return Promise.resolve()
  }

  public dispose(): void {
    this.disposeViewListeners()
    this.view = undefined
  }

  private disposeViewListeners(): void {
    while (this.disposables.length > 0) this.disposables.pop()?.dispose()
  }
}
