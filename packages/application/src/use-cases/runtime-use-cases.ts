import type { DshUpdateSnapshot } from '@dsh-vscode/domain'

export interface RuntimeActionPort {
  install(): Promise<void>
  selectExecutable(): Promise<void>
  copyInstallCommand(): Promise<void>
  openDocumentation(): Promise<void>
  checkForUpdates(force: boolean, signal?: AbortSignal): Promise<DshUpdateSnapshot>
  installVersion(version: string, signal?: AbortSignal): Promise<DshUpdateSnapshot>
}

export class RuntimeUseCases {
  public constructor(private readonly actions: RuntimeActionPort) {}

  public execute(action: 'install' | 'select' | 'copy-command' | 'open-docs'): Promise<void> {
    switch (action) {
      case 'install':
        return this.actions.install()
      case 'select':
        return this.actions.selectExecutable()
      case 'copy-command':
        return this.actions.copyInstallCommand()
      case 'open-docs':
        return this.actions.openDocumentation()
    }
  }

  public checkForUpdates(force = false, signal?: AbortSignal): Promise<DshUpdateSnapshot> {
    return this.actions.checkForUpdates(force, signal)
  }

  public installVersion(version: string, signal?: AbortSignal): Promise<DshUpdateSnapshot> {
    return this.actions.installVersion(version, signal)
  }
}
