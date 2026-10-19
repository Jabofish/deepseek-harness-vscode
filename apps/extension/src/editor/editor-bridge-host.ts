import { randomUUID } from 'node:crypto'
import path from 'node:path'
import * as vscode from 'vscode'
import {
  EditorBridgeService,
  EditorCompanionService,
  type BackendService,
  type DshConnectionCoordinator,
} from '@dsh-vscode/application'
import {
  AppError,
  isLoopbackEndpoint,
  type DshBackend,
  type EditorCompanionCapability,
  type EditorCompanionDescription,
} from '@dsh-vscode/domain'
import type { RequestGateway } from '../composition/request-handler.js'
import { EditorStateProvider } from './editor-state-provider.js'
import { workspaceFolderId } from './workspace-path-guard.js'
import { EditorCompanionProvider } from './editor-companion-provider.js'
import { EditorCompanionManagement } from './editor-companion-management.js'
import { verifyCompanionHost } from './companion-host-proof.js'

interface Dependencies {
  readonly backendService: BackendService
  readonly coordinator: DshConnectionCoordinator
  readonly sessionNavigation: RequestGateway['sessionNavigation']
  readonly context?: Pick<vscode.ExtensionContext, 'extensionUri' | 'globalStorageUri'>
  readonly reconnect?: (signal?: AbortSignal) => Promise<unknown>
}

/** Native user actions own the grant; no binding identity, credentials or paths enter Webview state. */
export class EditorBridgeHost {
  private readonly service: EditorBridgeService
  private readonly companion: EditorCompanionService
  private readonly management: EditorCompanionManagement
  private provider: EditorCompanionProvider | undefined
  private capabilities: readonly EditorCompanionCapability[] = []
  private status: vscode.StatusBarItem | undefined
  private scope: { readonly backend: DshBackend; readonly sessionId: string } | undefined
  private starting: AbortController | undefined
  private disposed = false
  private readonly subscriptions: { dispose(): unknown }[]

  public constructor(private readonly deps: Dependencies) {
    const stopped = (): void => {
      this.scope = undefined
      this.provider?.dispose()
      this.provider = undefined
      this.capabilities = []
      this.status?.hide()
    }
    this.service = new EditorBridgeService(stopped)
    this.companion = new EditorCompanionService(stopped)
    this.management = new EditorCompanionManagement({
      backend: () => deps.backendService.requireBackend(),
      current: (backend) => this.currentBackend(backend),
      extensionUri: deps.context?.extensionUri,
      storageUri: deps.context?.globalStorageUri,
      reconnect: deps.reconnect,
      enable: () => this.enable(),
      stop: () => this.stop(),
      active: () => this.service.active || this.companion.active,
      review: () => this.reviewEdits(),
    })
    this.subscriptions = [
      {
        dispose: deps.coordinator.subscribe((state) => {
          if (state.kind !== 'connected') this.management.cancel()
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
    if (
      this.disposed ||
      this.starting !== undefined ||
      this.service.active ||
      this.companion.active ||
      this.management.busy
    )
      return false
    const controller = new AbortController()
    this.starting = controller
    try {
      const backend = this.deps.backendService.requireBackend()
      const sessionId = this.deps.sessionNavigation.activeSessionId
      if (
        !vscode.workspace.isTrusted ||
        (vscode.workspace.workspaceFolders?.length ?? 0) === 0 ||
        sessionId === undefined
      )
        throw new Error(
          'Open one trusted workspace folder and select a DSH session before sharing editor tools.',
        )
      if (!isLoopbackEndpoint(backend.connection.endpoint) || backend.editorBridge === undefined)
        throw new Error('Editor sharing requires a local DSH 0.2.1-rc.2 with the editor companion installed.')
      const session = await backend.sessions.get(sessionId, controller.signal)
      controller.signal.throwIfAborted()
      const folder = vscode.workspace.workspaceFolders?.find(
        (candidate) => session.cwd !== undefined && samePath(session.cwd, candidate.uri.fsPath),
      )
      if (
        folder === undefined ||
        !(
          folder.uri.scheme === 'file' ||
          (folder.uri.scheme === 'vscode-remote' && vscode.env.remoteName !== undefined)
        ) ||
        !this.currentBackend(backend) ||
        this.deps.sessionNavigation.activeSessionId !== sessionId ||
        !vscode.workspace.isTrusted
      )
        throw new Error('The selected DSH session must belong to the open workspace folder.')
      this.scope = { backend, sessionId }
      const current = (): boolean =>
        this.scope?.backend === backend &&
        this.scope.sessionId === sessionId &&
        this.currentBackend(backend) &&
        this.deps.sessionNavigation.activeSessionId === sessionId
      const companion = backend.editorBridge.companion
      let description: EditorCompanionDescription | undefined
      if (companion !== undefined) {
        try {
          description = await companion.describe(controller.signal)
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE')) throw error
        }
      }
      if (companion !== undefined && description !== undefined) {
        await verifyCompanionHost(companion, controller.signal)
        if (backend.connection.ownership !== 'managed') {
          const consent = await vscode.window.showWarningMessage(
            'Share editor access with this external DSH session?',
            {
              modal: true,
              detail:
                'The selected permissions expose editor data from this workspace to the connected DSH session. Confirm only if you trust that runtime.',
            },
            'Continue',
          )
          controller.signal.throwIfAborted()
          if (consent !== 'Continue') {
            this.scope = undefined
            return false
          }
        }
        const labels: Record<EditorCompanionCapability, { label: string; description: string }> = {
          content: {
            label: 'Read code and selection',
            description: 'Includes unsaved text inside the selected workspace root',
          },
          diagnostics: {
            label: 'Read diagnostics',
            description: 'Messages and positions from the current diagnostic cache',
          },
          language: {
            label: 'Query language services',
            description: 'Symbols, definitions and references within the selected root',
          },
          navigation: {
            label: 'Open files',
            description: 'Open validated files without taking keyboard focus',
          },
          edit: {
            label: 'Propose edits',
            description: 'Writes require a separate native diff review and explicit confirmation',
          },
        }
        const picked = await vscode.window.showQuickPick(
          description.capabilities.map((capability) => ({
            ...labels[capability],
            capability,
            picked: false,
          })),
          {
            canPickMany: true,
            title: `DSH editor access: ${folder.name}`,
            placeHolder:
              'Select permissions. No selection shares metadata only. Access ends when the session or connection changes.',
          },
        )
        controller.signal.throwIfAborted()
        if (picked === undefined) {
          this.scope = undefined
          return false
        }
        if (!current() || !vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.includes(folder))
          throw new Error('The selected DSH session must belong to the open workspace folder.')
        this.capabilities = picked.map((item) => item.capability)
        this.provider = new EditorCompanionProvider(folder, this.capabilities, current, () =>
          this.updateStatus(),
        )
        await this.companion.start(companion, sessionId, randomUUID(), this.capabilities, this.provider)
      } else {
        if (
          backend.connection.ownership !== 'managed' ||
          vscode.workspace.workspaceFolders?.length !== 1 ||
          folder.uri.scheme !== 'file'
        )
          throw new Error(
            'Editor sharing requires the current editor companion for external instances or multiple workspace roots.',
          )
        await this.service.start(
          backend.editorBridge,
          sessionId,
          randomUUID(),
          new EditorStateProvider(workspaceFolderId(folder), current),
        )
      }
      controller.signal.throwIfAborted()
      if (!this.service.active && !this.companion.active) return false
      this.status ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10)
      this.updateStatus()
      return true
    } catch (error) {
      await Promise.all([this.service.stop(), this.companion.stop()])
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
    return Promise.all([this.service.stop(), this.companion.stop()]).then(() => undefined)
  }
  public manage(): Promise<void> {
    return this.management.manage()
  }
  public install(): Promise<void> {
    return this.management.installBundled()
  }
  public async reviewEdits(): Promise<void> {
    const proposals = this.provider?.proposals
    const pending = proposals?.pending() ?? []
    if (pending.length === 0) {
      void vscode.window.showInformationMessage('No editor edit proposals are awaiting review.')
      return
    }
    const choice = await vscode.window.showQuickPick(
      pending.map((item) => ({
        label: item.relativePath,
        description: `Document version ${item.version}`,
        proposalId: item.proposalId,
      })),
      { title: 'Review DSH editor edits' },
    )
    if (choice !== undefined && this.provider?.proposals === proposals)
      await proposals?.review(choice.proposalId)
  }
  public async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
    await this.management.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.status?.dispose()
  }
  private updateStatus(): void {
    if (this.status === undefined) return
    if (!this.service.active && !this.companion.active) {
      this.status.hide()
      return
    }
    const pending = this.provider?.proposals.pending().length ?? 0
    this.status.text =
      pending > 0
        ? `$(edit) DSH: ${pending} edit proposal${pending === 1 ? '' : 's'}`
        : this.companion.active && this.capabilities.length > 0
          ? '$(broadcast) DSH: Editor tools shared'
          : '$(broadcast) DSH: Editor state shared'
    this.status.tooltip = this.companion.active
      ? `Editor tools shared: metadata${this.capabilities.length > 0 ? ', ' + this.capabilities.join(', ') : ''}. Click to manage access or review edits.`
      : 'Share editor metadata with the selected DSH session. Click to stop sharing.'
    this.status.command = this.companion.active ? 'dsh.manageEditorCompanion' : 'dsh.stopSharingEditorState'
    this.status.show()
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
