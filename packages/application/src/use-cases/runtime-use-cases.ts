import { unimplemented } from '@dsh-vscode/domain'

export interface RuntimeActionPort {
  install(): Promise<void>
  selectExecutable(): Promise<void>
  copyInstallCommand(): Promise<void>
  openDocumentation(): Promise<void>
}

export class RuntimeUseCases {
  public constructor(private readonly actions: RuntimeActionPort) {}

  public execute(action: 'install' | 'select' | 'copy-command' | 'open-docs'): Promise<void> {
    return unimplemented<Promise<void>>('runtime missing action dispatcher', [
      'route only the four allowed user-initiated actions',
      'install with npm in an explicit VS Code task or terminal and show progress',
      'never download or execute an opaque binary',
      'retry discovery after successful installation or executable selection',
      `requested action: ${action}; action port available: ${String(this.actions !== undefined)}`,
    ])
  }
}
