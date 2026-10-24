import type * as vscode from 'vscode'
import { AppError } from '@dsh-vscode/domain'

import { DSH_DOCUMENTATION_URL, INSTALL_COMMAND } from '../constants.js'
import { runtimeInstallationFailureMessage } from './runtime-installation.js'

export interface RuntimeInstallerDependencies {
  readonly tasks: typeof vscode.tasks
  readonly window: typeof vscode.window
  readonly env: typeof vscode.env
  readonly Uri: typeof vscode.Uri
  readonly workspace?: typeof vscode.workspace
  readonly runInstall?: () => Promise<void>
  readonly verifyInstall?: () => Promise<boolean>
  readonly verifyExecutable?: (path: string) => Promise<boolean>
}

export class RuntimeInstaller {
  public constructor(private readonly dependencies: RuntimeInstallerDependencies) {}

  public install(): Promise<void> {
    if (this.dependencies.runInstall !== undefined) {
      return this.dependencies
        .runInstall()
        .then(async () => {
          if (this.dependencies.verifyInstall !== undefined && !(await this.dependencies.verifyInstall()))
            throw runtimeInstallError(
              'verify-failed',
              'DSH installation finished, but the installed executable could not be verified.',
              true,
            )
        })
        .catch((error: unknown) => {
          if (error instanceof AppError) throw error
          if (isMissingExecutable(error))
            throw runtimeInstallError(
              'npm-not-found',
              'npm was not found in the Extension Host environment. Use Copy command or open a terminal to install DSH.',
              true,
              error,
            )
          throw runtimeInstallError(
            'install-failed',
            runtimeInstallationFailureMessage(error) ??
              'The DSH installation command failed. Check the npm install log and try again.',
            true,
            error,
          )
        })
    }
    const terminal = this.dependencies.window.createTerminal({ name: 'Install DeepSeek Harness' })
    terminal.show(true)
    terminal.sendText(INSTALL_COMMAND, true)
    return Promise.resolve()
  }

  public copyInstallCommand(): Thenable<void> {
    return this.dependencies.env.clipboard.writeText(INSTALL_COMMAND).then(() => undefined)
  }

  public async selectExecutable(): Promise<void> {
    const selected = await this.dependencies.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Use DSH executable',
      filters: { Executable: process.platform === 'win32' ? ['cmd', 'exe'] : ['*'] },
    })
    const path = selected?.[0]?.fsPath
    if (path === undefined || this.dependencies.workspace === undefined) return
    if (this.dependencies.verifyExecutable !== undefined && !(await this.dependencies.verifyExecutable(path)))
      throw new AppError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The selected executable is not a supported DeepSeek Harness runtime.',
        retryable: false,
        context: { operation: 'runtime.select', reason: 'invalid-executable' },
      })
    await this.dependencies.workspace.getConfiguration('dsh').update('runtime.executablePath', path, true)
  }

  public openDocumentation(): Thenable<boolean> {
    return this.dependencies.env.openExternal(this.dependencies.Uri.parse(DSH_DOCUMENTATION_URL))
  }
}

function runtimeInstallError(
  reason: 'verify-failed' | 'npm-not-found' | 'install-failed',
  message: string,
  retryable: boolean,
  cause?: unknown,
): AppError {
  return new AppError({
    code:
      reason === 'npm-not-found' || reason === 'verify-failed' ? 'DSH_NOT_FOUND' : 'INVALID_CONFIGURATION',
    message,
    retryable,
    cause,
    context: { operation: 'runtime.install', reason },
  })
}

function isMissingExecutable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { readonly code?: unknown }).code === 'ENOENT'
}
