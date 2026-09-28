import type * as vscode from 'vscode'

export async function moveOrExplainSecondarySidebar(
  commands: typeof vscode.commands,
  window: typeof vscode.window,
): Promise<void> {
  try {
    const available = new Set(await commands.getCommands(true))
    if (available.has('workbench.action.moveView')) {
      // Let VS Code ask which view and destination to use. Its workbench owns
      // the layout and persists the user's choice across sessions.
      await commands.executeCommand('workbench.action.moveView')
      return
    }
  } catch {
    // Keep the manual route available when the workbench command is absent or fails.
  }
  await window.showInformationMessage(
    'Right-click the DeepSeek Harness Chat view title, choose Move View, then a new Secondary Side Bar entry.',
  )
}
