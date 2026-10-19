import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as vscode from 'vscode'
import {
  EditorBridgeService,
  type BackendService,
  type DshConnectionCoordinator,
} from '@dsh-vscode/application'
import { isLoopbackEndpoint, type DshBackend } from '@dsh-vscode/domain'
import type { RequestGateway } from '../composition/request-handler.js'
import { EditorStateProvider } from './editor-state-provider.js'
import { workspaceFolderId } from './workspace-path-guard.js'

interface Dependencies {
  readonly backendService: BackendService
  readonly coordinator: DshConnectionCoordinator
  readonly sessionNavigation: RequestGateway['sessionNavigation']
}

/** Native user actions own the grant; no binding identity, credentials or paths enter Webview state. */
export class EditorBridgeHost {
  private readonly service: EditorBridgeService
  private status: vscode.StatusBarItem | undefined
  private scope: { readonly backend: DshBackend; readonly sessionId: string } | undefined
  private starting: AbortController | undefined
  private disposed = false
  private readonly subscriptions: { dispose(): unknown }[]

  public constructor(private readonly deps: Dependencies) {
    this.service = new EditorBridgeService(() => {
      this.scope = undefined
      this.status?.hide()
    })
    this.subscriptions = [
      {
        dispose: deps.coordinator.subscribe((state) => {
          if (this.starting !== undefined || this.scope !== undefined) {
            if (
              state.kind !== 'connected' ||
              (this.scope !== undefined && state.backend !== this.scope.backend.connection)
            )
              void this.stop()
          }
        }),
      },
      deps.sessionNavigation.onDidChange((change) => {
        if (change === 'selection' && this.starting !== undefined) void this.stop()
        if (this.scope !== undefined && deps.sessionNavigation.activeSessionId !== this.scope.sessionId)
          void this.stop()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.stop()
      }),
    ]
  }

  public async enable(): Promise<boolean> {
    if (this.disposed || this.starting !== undefined || this.service.active) return false
    const controller = new AbortController()
    this.starting = controller
    try {
      const backend = this.deps.backendService.requireBackend()
      const folder = vscode.workspace.workspaceFolders?.[0]
      const sessionId = this.deps.sessionNavigation.activeSessionId
      if (
        !vscode.workspace.isTrusted ||
        vscode.workspace.workspaceFolders?.length !== 1 ||
        folder?.uri.scheme !== 'file' ||
        sessionId === undefined
      )
        throw new Error(
          'Open one trusted workspace folder and select a DSH session before sharing editor state.',
        )
      if (
        backend.connection.ownership !== 'managed' ||
        !isLoopbackEndpoint(backend.connection.endpoint) ||
        backend.editorBridge === undefined
      )
        throw new Error(
          'Editor sharing requires an extension-managed local DSH 0.2.1-rc.2 with the editor companion installed.',
        )
      const session = await backend.sessions.get(sessionId, controller.signal)
      controller.signal.throwIfAborted()
      if (
        session.cwd === undefined ||
        !samePath(session.cwd, folder.uri.fsPath) ||
        !this.currentBackend(backend) ||
        this.deps.sessionNavigation.activeSessionId !== sessionId ||
        vscode.workspace.workspaceFolders?.[0] !== folder
      )
        throw new Error('The selected DSH session must belong to the open workspace folder.')
      this.scope = { backend, sessionId }
      await this.service.start(
        backend.editorBridge,
        sessionId,
        randomUUID(),
        new EditorStateProvider(
          workspaceFolderId(folder),
          () =>
            this.scope?.backend === backend &&
            this.scope.sessionId === sessionId &&
            this.currentBackend(backend) &&
            this.deps.sessionNavigation.activeSessionId === sessionId,
        ),
      )
      controller.signal.throwIfAborted()
      if (!this.service.active) return false
      this.status ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10)
      this.status.text = '$(broadcast) DSH: Editor state shared'
      this.status.tooltip = 'Share editor metadata with the selected DSH session. Click to stop sharing.'
      this.status.command = 'dsh.stopSharingEditorState'
      this.status.show()
      return true
    } catch (error) {
      await this.service.stop()
      if (!controller.signal.aborted && !this.disposed) {
        const message =
          error instanceof Error &&
          !(error.name === 'AppError') &&
          ['Open one trusted', 'Editor sharing requires', 'The selected DSH'].some((prefix) =>
            error.message.startsWith(prefix),
          )
            ? error.message
            : 'Editor sharing could not start. Check that the local editor companion is installed and enabled, then try again.'
        void vscode.window.showErrorMessage(message)
      }
      return false
    } finally {
      if (this.starting === controller) this.starting = undefined
    }
  }

  public stop(): Promise<void> {
    this.starting?.abort()
    this.scope = undefined
    return this.service.stop()
  }
  public async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.status?.dispose()
  }
  private currentBackend(backend: DshBackend): boolean {
    try {
      const state = this.deps.coordinator.getState()
      return (
        !this.disposed &&
        this.deps.backendService.requireBackend() === backend &&
        state.kind === 'connected' &&
        state.backend === backend.connection
      )
    } catch {
      return false
    }
  }
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(left) === normalize(right)
}
