import * as vscode from 'vscode'

import type { CompositionRoot } from './composition-root.js'

const lifecycle: { root: CompositionRoot | undefined } = { root: undefined }

export async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  if (lifecycle.root !== undefined) return
  const { createCompositionRoot } = await import('./composition-root.js')
  const root = createCompositionRoot(context)
  lifecycle.root = root
  try {
    await root.start()
  } catch (error) {
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
