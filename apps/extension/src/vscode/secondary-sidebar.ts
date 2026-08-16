import type * as vscode from 'vscode'

export async function moveOrExplainSecondarySidebar(
  commands: typeof vscode.commands,
  window: typeof vscode.window,
): Promise<void> {
  const available = new Set(await commands.getCommands(true))
  if (available.has('workbench.action.toggleAuxiliaryBar'))
    await commands.executeCommand('workbench.action.toggleAuxiliaryBar')
  else
    await window.showInformationMessage(
      'Drag the DeepSeek Harness view to the Secondary Side Bar to keep it beside your editor.',
    )
}
