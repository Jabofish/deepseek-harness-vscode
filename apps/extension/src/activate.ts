import * as vscode from 'vscode'

import type { CompositionRoot } from './composition-root.js'

const lifecycle: { root: CompositionRoot | undefined } = { root: undefined }

export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  if (lifecycle.root !== undefined) return
  try {
    const { createCompositionRoot } = await import('./composition-root.js')
    const root = createCompositionRoot(context)
    lifecycle.root = root
    await root.start()
  } catch (error) {
    // A rejected activate() is a broken extension: the window loses every
    // command this extension contributes. Keep the failure visible and leave
    // the host usable so the reported problem can be fixed and retried.
    await vscode.window.showErrorMessage(
      error instanceof Error ? error.message : 'DeepSeek Harness failed to activate.',
    )
  }
}

export async function deactivateExtension(): Promise<void> {
  const root = lifecycle.root
  lifecycle.root = undefined
  await root?.dispose()
}
