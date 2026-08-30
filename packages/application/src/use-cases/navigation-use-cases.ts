import type { EditorContextRange } from '@dsh-vscode/domain'

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

  public openDiff(
    workspaceFolderId: string,
    relativePath: string,
    before: string,
    after?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.navigation.openDiff(workspaceFolderId, relativePath, before, after, signal)
  }
}
