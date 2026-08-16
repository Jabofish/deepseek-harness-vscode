import type * as vscode from 'vscode'
import type { BackendState } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export function updateContextKeys(commands: typeof vscode.commands, state: BackendState): Promise<void> {
  return unimplemented<Promise<void>>('update DSH VS Code context keys', [
    'set dsh.connected, dsh.runtimeMissing, dsh.connecting, and dsh.sessionRunning from one state snapshot',
    'batch updates and avoid redundant setContext calls',
    'never encode endpoint, pid, model, or credential values in context keys',
    `state ${state.kind}; commands API available ${String(commands !== undefined)}`,
  ])
}
