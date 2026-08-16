import type * as vscode from 'vscode'
import { unimplemented } from '@dsh-vscode/domain'

import { INSTALL_COMMAND } from '../constants.js'

export interface RuntimeInstallerDependencies {
  readonly tasks: typeof vscode.tasks
  readonly window: typeof vscode.window
  readonly env: typeof vscode.env
}

export class RuntimeInstaller {
  public constructor(private readonly dependencies: RuntimeInstallerDependencies) {}

  public install(): Promise<void> {
    return unimplemented<Promise<void>>('user-visible DSH npm installation', [
      'require an explicit click or command invocation before installing',
      'check Node >=22.19 and npm availability first',
      'run the fixed npm global install command in a VS Code task or terminal',
      'show exit status, distinguish warnings from failure, and retry runtime detection only on success',
      'never elevate privileges automatically',
      `fixed command ${INSTALL_COMMAND}; tasks API available ${String(this.dependencies.tasks !== undefined)}`,
    ])
  }

  public copyInstallCommand(): Thenable<void> {
    return unimplemented<Thenable<void>>('copy fixed DSH install command', [
      'write exactly npm install --global @deepseek-ai/dsh to the clipboard',
      'show a non-modal confirmation',
      `clipboard API available ${String(this.dependencies.env.clipboard !== undefined)}`,
    ])
  }

  public selectExecutable(): Promise<void> {
    return unimplemented<Promise<void>>('select a DSH executable', [
      'open a single-file picker with platform-appropriate filters',
      'validate the selected binary using --version before saving configuration',
      'store an absolute machine-scoped path and reconnect',
      `window API available ${String(this.dependencies.window !== undefined)}`,
    ])
  }
}
