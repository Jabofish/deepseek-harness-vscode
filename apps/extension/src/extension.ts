import type * as vscode from 'vscode'

import { activateExtension, deactivateExtension } from './activate.js'

export function activate(context: vscode.ExtensionContext): Promise<void> {
  return activateExtension(context)
}

export function deactivate(): Promise<void> {
  return deactivateExtension()
}
