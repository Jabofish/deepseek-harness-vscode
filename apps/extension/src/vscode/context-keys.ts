import type * as vscode from 'vscode'
import type { BackendState } from '@dsh-vscode/domain'

const previous = new Map<string, boolean>()
export function updateContextKeys(commands: typeof vscode.commands, state: BackendState): Promise<void> {
  const values = {
    'dsh.connected': state.kind === 'connected',
    'dsh.runtimeMissing': state.kind === 'runtime-missing',
    'dsh.connecting':
      state.kind === 'locating-runtime' ||
      state.kind === 'discovering' ||
      state.kind === 'connecting' ||
      state.kind === 'starting',
    'dsh.sessionRunning': state.kind === 'connected',
  }
  const updates: Promise<unknown>[] = []
  for (const [key, value] of Object.entries(values)) {
    if (previous.get(key) === value) continue
    previous.set(key, value)
    updates.push(Promise.resolve(commands.executeCommand('setContext', key, value)).then(() => undefined))
  }
  return Promise.all(updates).then(() => undefined)
}
