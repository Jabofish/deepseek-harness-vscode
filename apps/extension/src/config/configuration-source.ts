import type * as vscode from 'vscode'
import type { ExtensionSettings } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export class VsCodeConfigurationSource {
  public constructor(private readonly workspace: typeof vscode.workspace) {}

  public read(): ExtensionSettings {
    return unimplemented<ExtensionSettings>('read and validate VS Code DSH settings', [
      'read every dsh.* setting declared in package.json',
      'validate port ranges, timeouts, enum values, and absolute executable path',
      'bind the backend host permanently to loopback',
      'merge defaults without silently repairing invalid explicit values',
      `workspace API available ${String(this.workspace !== undefined)}`,
    ])
  }

  public onDidChange(listener: () => void): vscode.Disposable {
    return unimplemented<vscode.Disposable>('subscribe to relevant DSH configuration changes', [
      'listen only for changes affecting dsh.*',
      'debounce reconnection-relevant settings',
      'refresh UI-only defaults without unnecessary reconnects',
      `listener type ${typeof listener}`,
    ])
  }
}
