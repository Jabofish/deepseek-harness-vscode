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
const COMMANDS = [
  'dsh.connect',
  'dsh.reconnect',
  'dsh.newSession',
  'dsh.openSettings',
  'dsh.installRuntime',
  'dsh.selectExecutable',
  'dsh.copyInstallCommand',
  'dsh.openDocumentation',
  'dsh.openInSecondarySidebar',
  'dsh.showDiagnostics',
] as const
