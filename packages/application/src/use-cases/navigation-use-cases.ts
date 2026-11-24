import type { ChangeDiff, ChangeFileStatus, EditorContextRange } from '@dsh-vscode/domain'

import type { NavigationPort } from '../ports/feature-ports.js'

export class NavigationUseCases {
  public constructor(private readonly navigation: NavigationPort) {}

  public openFile(
    workspaceFolderId: string,
    relativePath: string,
    range?: EditorContextRange,
    signal?: AbortSignal,
    preserveFocus?: boolean,
  ): Promise<void> {
    return this.navigation.openFile(workspaceFolderId, relativePath, range, signal, preserveFocus)
  }

  public revealLine(
    workspaceFolderId: string,
    relativePath: string,
    line: number,
    column?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.navigation.revealLine(workspaceFolderId, relativePath, line, column, signal)
  }

  public showInExplorer(
    workspaceFolderId: string,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.navigation.showInExplorer(workspaceFolderId, relativePath, signal)
  }

  public openChangeDiff(
    workspaceFolderId: string,
    relativePath: string,
    status: ChangeFileStatus,
    diffs: readonly ChangeDiff[],
    signal?: AbortSignal,
  ): Promise<void> {
    return this.navigation.openChangeDiff(workspaceFolderId, relativePath, status, diffs, signal)
  }
}
