import type * as vscode from 'vscode'

export interface CommandDependencies {
  readonly commands: typeof vscode.commands
  readonly subscriptions: { push(...items: vscode.Disposable[]): unknown }
  readonly handlers?: Partial<Record<CommandId, (...args: readonly unknown[]) => unknown>>
}

export function registerCommands(dependencies: CommandDependencies): void {
  for (const id of COMMANDS) {
    const handler = dependencies.handlers?.[id]
    const disposable = dependencies.commands.registerCommand(id, (...args: unknown[]) => handler?.(...args))
    dependencies.subscriptions.push(disposable)
  }
}

export type CommandId = (typeof COMMANDS)[number]
export const COMMANDS = [
  'dsh.authorizeExternalConnection',
  'dsh.clearExternalCredentials',
  'dsh.connect',
  'dsh.reconnect',
  'dsh.newSession',
  'dsh.openSessionList',
  'dsh.openSettings',
  'dsh.openWebUi',
  'dsh.installRuntime',
  'dsh.selectExecutable',
  'dsh.copyInstallCommand',
  'dsh.openDocumentation',
  'dsh.openInSecondarySidebar',
  'dsh.openChatInEditor',
  'dsh.moveChatToSidebar',
  'dsh.showDiagnostics',
  'dsh.addSelectionContext',
  'dsh.addFileContext',
  'dsh.addSymbolContext',
  'dsh.addDiagnosticContext',
  'dsh.shareEditorState',
  'dsh.stopSharingEditorState',
  'dsh.manageEditorCompanion',
  'dsh.installEditorCompanion',
  'dsh.undoEditorEdit',
] as const
