import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export function createWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return unimplemented<string>('secure Webview HTML shell', [
    'create a cryptographically random nonce',
    'permit scripts only from nonce and webview.cspSource',
    'forbid remote scripts, inline handlers, arbitrary frames, and unsafe-eval',
    'resolve media/webview.js and media/webview.css with asWebviewUri',
    'include viewport, theme-compatible color-scheme, and accessible root landmark',
    `extension URI ${extensionUri.toString()}; CSP source ${webview.cspSource}`,
  ])
}
