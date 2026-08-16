import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

import { VIEW_ID } from '../constants.js'

export interface DshWebviewDependencies {
  readonly extensionUri: vscode.Uri
  readonly onMessage: (message: unknown) => Promise<void>
}

export class DshWebviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = VIEW_ID
  private view: vscode.WebviewView | undefined

  public constructor(private readonly dependencies: DshWebviewDependencies) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    return unimplemented<void | Thenable<void>>('resolve DSH Webview View', [
      'retain the current view and configure enableScripts plus minimal localResourceRoots',
      'generate nonce-based CSP HTML referencing only packaged Webview JS and CSS',
      'validate every incoming message with webview-protocol before routing',
      'dispose listeners when the view is replaced or hidden permanently',
      'publish the current backend/runtime snapshot after app.ready',
      `view type ${webviewView.viewType}; extension URI ${this.dependencies.extensionUri.toString()}; prior view ${String(this.view !== undefined)}`,
    ])
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return unimplemented<Thenable<boolean>>('post a protocol message to the DSH Webview', [
      'send only validated versioned HostMessage values',
      'return false while the view is not resolved without throwing',
      'coalesce high-frequency streaming updates before crossing the Webview boundary',
      `message type ${typeof message}; view present ${String(this.view !== undefined)}`,
    ])
  }

  public reveal(preserveFocus = true): Promise<void> {
    return unimplemented<Promise<void>>('reveal DSH Webview View', [
      'focus or reveal dsh.chatView through supported VS Code commands',
      'respect preserveFocus',
      `preserveFocus ${String(preserveFocus)}`,
    ])
  }

  public dispose(): void {
    unimplemented<void>('dispose DSH Webview provider', [
      'dispose message and visibility subscriptions',
      'release the view reference',
      'do not dispose the globally owned connection directly',
    ])
  }
}
