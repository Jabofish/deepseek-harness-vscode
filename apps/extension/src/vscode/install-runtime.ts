import type * as vscode from 'vscode'
import { AppError } from '@dsh-vscode/domain'

import { DSH_DOCUMENTATION_URL, INSTALL_COMMAND } from '../constants.js'

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
    if (!isSupportedNodeVersion())
      return Promise.reject(
        runtimeInstallError(
          'node-version',
          'DSH installation requires Node.js 22.19.0 or newer in the Extension Host.',
          false,
        ),
      )
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
            'The DSH installation command failed. Check the install output and try again.',
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

export function isSupportedNodeVersion(version = process.versions.node): boolean {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)))
}

function runtimeInstallError(
  reason: 'node-version' | 'verify-failed' | 'npm-not-found' | 'install-failed',
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
