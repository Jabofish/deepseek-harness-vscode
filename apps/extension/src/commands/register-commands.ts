import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

export interface CommandDependencies {
  readonly commands: typeof vscode.commands
  readonly subscriptions: { push(...items: vscode.Disposable[]): unknown }
}

export function registerCommands(dependencies: CommandDependencies): void {
  unimplemented<void>('register all contributed DSH commands', [
    'register exactly every command declared in package.json',
    'delegate command bodies to application use cases or VS Code boundary services',
    'show progress and map expected errors to actionable messages',
    'avoid starting a new DSH from new-session until attach-first coordination completes',
    'push every command disposable into the extension context subscriptions',
    `commands API available ${String(dependencies.commands !== undefined)}; subscriptions available ${String(dependencies.subscriptions !== undefined)}`,
  ])
}
