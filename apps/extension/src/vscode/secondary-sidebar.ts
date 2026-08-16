import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export function moveOrExplainSecondarySidebar(
  commands: typeof vscode.commands,
  window: typeof vscode.window,
): Promise<void> {
  return unimplemented<Promise<void>>('place DSH view in the Secondary Side Bar', [
    'use a supported built-in move-view command only if it is documented and available in the running VS Code version',
    'otherwise reveal the DSH view and show concise drag-and-drop instructions',
    'never depend on proposed APIs or private workbench internals',
    'VS Code persists the user-selected view location, so do not repeat the prompt',
    `commands API available ${String(commands !== undefined)}; window API available ${String(window !== undefined)}`,
  ])
}
