import * as vscode from 'vscode'
import { randomBytes } from 'node:crypto'

export function createWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64url')
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'))
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'))
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    "connect-src 'none'",
    "frame-src 'none'",
  ].join('; ')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="light dark">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${style.toString()}">
    <title>DeepSeek Harness</title>
  </head>
  <body>
    <main id="root" aria-live="polite"></main>
    <script type="module" nonce="${nonce}" src="${script.toString()}"></script>
  </body>
</html>`
}
