import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

import type { CompositionRoot } from './composition-root.js'

const lifecycle: { root?: CompositionRoot } = {}

export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  return unimplemented<Promise<void>>('VS Code extension activation', [
    'create the composition root with VS Code APIs and immutable configuration',
    'register the WebviewViewProvider, commands, diagnostics, and configuration listeners',
    'start auto-connect lazily when the DSH view becomes visible or a DSH command runs',
    'store every disposable in ExtensionContext.subscriptions',
    'show actionable errors without throwing through the extension host',
    `extension path ${context.extensionPath}; existing root ${String(lifecycle.root !== undefined)}`,
  ])
}

export async function deactivateExtension(): Promise<void> {
  return unimplemented<Promise<void>>('VS Code extension deactivation', [
    'cancel activation and outstanding requests',
    'dispose the composition root and managed process only',
    'never stop externally-owned DSH instances',
    'resolve within the VS Code shutdown budget',
    `root present ${String(lifecycle.root !== undefined)}`,
  ])
}
