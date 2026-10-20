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
  EditorCompanionError,
  isLoopbackEndpoint,
  type DshBackend,
  type EditorCompanionCapability,
  type EditorCompanionDescription,
  type EditorIntegrationStatus,
  type EditorIntegrationPreferences,
} from '@dsh-vscode/domain'
import type { RequestGateway } from '../composition/request-handler.js'
import { isPathWithin } from '../backend/path-safety.js'
import { EditorStateProvider } from './editor-state-provider.js'
import { workspaceFolderId } from './workspace-path-guard.js'
import { EditorCompanionProvider } from './editor-companion-provider.js'
import { EditorCompanionManagement } from './editor-companion-management.js'
import type { Applied } from './companion-edit-proposals.js'
import { verifyCompanionHost } from './companion-host-proof.js'
import { EditLedger, revertEdit } from './edit-ledger.js'
import { readEditorPreferences, saveEditorPreferences } from './editor-integration-settings.js'
import { EditorWorkspaceAccess } from './editor-workspace-access.js'
import { companionNeedsUpdate } from './companion-update.js'
import {
  checkCompanionPackageManager,
  prepareCompanionPackageManager,
  PNPM_INSTALL_COMMAND,
  PNPM_INSTALL_GUIDE,
} from './companion-prerequisites.js'
import { cleanupLegacyCompanion } from './legacy-companion-cleanup.js'

interface Dependencies {
  readonly backendService: BackendService
  readonly coordinator: DshConnectionCoordinator
  readonly sessionNavigation: RequestGateway['sessionNavigation']
  readonly context?: Pick<vscode.ExtensionContext, 'extensionUri' | 'globalStorageUri'>
  readonly reconnect?: (signal?: AbortSignal) => Promise<unknown>
}

/**
 * Trusted workspaces share automatically according to persistent editor preferences.
 * Settings owns access and setup controls; native Undo remains available for direct edits.
 */
export class EditorBridgeHost {
  private readonly service: EditorBridgeService
  private readonly companion: EditorCompanionService
  private readonly management: EditorCompanionManagement
  private readonly checkedUpdates = new WeakSet<DshBackend>()
  private preparing: AbortController | undefined
  private prerequisiteOutcome: EditorIntegrationStatus['installation']
  private readonly ledger = new EditLedger()
  private readonly workspaceAccess = new EditorWorkspaceAccess(
    () => !this.disposed && !this.suppressed && readEditorPreferences().enabled,
  )
  private provider: EditorCompanionProvider | undefined
  private capabilities: readonly EditorCompanionCapability[] = []
  private status: vscode.StatusBarItem | undefined
  private editStatus: vscode.StatusBarItem | undefined
  private decoration: vscode.TextEditorDecorationType | undefined
  private editTimer: ReturnType<typeof setTimeout> | undefined
  private readonly flashTimers = new Set<ReturnType<typeof setTimeout>>()
  private recovery: ReturnType<typeof setTimeout> | undefined
  private recoveryAttempts = 0
  private phase: EditorIntegrationStatus['phase'] = 'waiting'
  private reason: EditorIntegrationStatus['reason'] = 'disconnected'
  private version: string | undefined
  private syncOperation: Promise<void> | undefined
  private syncRequested = false
  private scope: { readonly backend: DshBackend; readonly sessionId: string } | undefined
  private starting: AbortController | undefined
  private suppressed = false
  private disposed = false
  private readonly subscriptions: { dispose(): unknown }[]

  public constructor(private readonly deps: Dependencies) {
    const stopped = (reason: 'requested' | 'ended' = 'requested'): void => {
      const wasActive = this.scope !== undefined
      this.scope = undefined
      this.provider?.dispose()
      this.provider = undefined
      this.capabilities = []
      this.status?.hide()
      if (reason === 'ended' && wasActive) {
        this.phase = 'limited'
        this.reason = 'connection'
      }
      if (reason === 'ended' && wasActive && !this.disposed) this.scheduleRecovery()
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
      stop: () => this.stopByUser(),
      halt: () => this.stop(),
      active: () => this.service.active || this.companion.active,
      undo: () => this.undoLastEdit(),
      checkPackageManager: checkCompanionPackageManager,
    })
    if (deps.context?.globalStorageUri !== undefined)
      void cleanupLegacyCompanion(deps.context.globalStorageUri.fsPath).catch(() => undefined)
    this.subscriptions = [
      {
        dispose: deps.coordinator.subscribe((state) => {
          if (state.kind !== 'connected') {
            this.management.cancel()
            void this.stop()
            this.phase = 'waiting'
            this.reason = 'disconnected'
          } else void this.reconcile()
        }),
      },
      deps.sessionNavigation.onDidChange((change) => {
        if (change === 'selection') {
          this.starting?.abort()
          void this.reconcile()
        }
        // Coordinator readiness precedes BackendService attachment. The later
        // navigation connection event is the authoritative point to retry.
        if (change === 'connection') void this.reconcile()
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.workspaceAccess.reset()
        this.starting?.abort()
        void this.stop().then(() => this.reconcile())
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dsh.editor')) {
          this.suppressed = !readEditorPreferences().enabled
          this.starting?.abort()
          void this.stop().then(() => this.reconcile())
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.workspaceAccess.reset()
        if (this.companion.active) {
          this.reason = this.workspaceAccess.reason()
          this.phase = this.reason === undefined ? 'ready' : 'waiting'
        }
        void this.reconcile()
      }),
    ]
  }

  public async enable(options: { silent?: boolean } = {}): Promise<boolean> {
    if (this.disposed || this.starting !== undefined || this.management.busy) return false
    if (!options.silent && !readEditorPreferences().enabled) await saveEditorPreferences({ enabled: true })
    if (!readEditorPreferences().enabled || (options.silent && this.suppressed)) {
      this.phase = 'off'
      this.reason = undefined
      return false
    }
    this.suppressed = false
    if (this.service.active || this.companion.active) return true
    const controller = new AbortController()
    this.starting = controller
    try {
      const backend = this.deps.backendService.requireBackend()
      const sessionId = this.deps.sessionNavigation.activeSessionId
      if (sessionId === undefined) {
        this.phase = 'waiting'
        this.reason = 'session'
        return false
      }
      if (!isLoopbackEndpoint(backend.connection.endpoint) || backend.editorBridge === undefined) {
        this.phase = 'limited'
        this.reason = 'unsupported'
        return false
      }
      this.phase = 'connecting'
      this.reason = undefined
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
        if (!current()) throw new EditorCompanionError('cancelled')
        // Persisted workspace preferences control access without a per-session permission picker.
        this.version = description.packageVersion
        this.capabilities = description.capabilities.filter(
          (capability) => capability !== 'edit' || readEditorPreferences().allowEdits,
        )
        // Bind before workspace access is available so the first tool can ask for it.
        // File access is still checked by the provider against this window's trusted roots.
        const capabilities = this.capabilities
        await this.companion.start(companion, sessionId, randomUUID(), capabilities, {
          execute: async (request, signal) => {
            await this.workspaceAccess.request(signal)
            if (!current() || !readEditorPreferences().enabled || this.suppressed)
              throw new EditorCompanionError('cancelled')
            this.provider ??= new EditorCompanionProvider(
              this.workspaceAccess.folders(),
              capabilities,
              current,
              this.ledger,
              (applied) => this.showEditIndicator(applied),
            )
            this.phase = 'ready'
            this.reason = undefined
            return this.provider.execute(request, signal)
          },
        })
      } else {
        const blocked = this.workspaceAccess.reason()
        if (blocked !== undefined) {
          this.phase = 'waiting'
          this.reason = blocked
          this.scope = undefined
          return false
        }
        const session = await backend.sessions.get(sessionId, controller.signal)
        controller.signal.throwIfAborted()
        const primary = this.folderFor(session.cwd)
        const folders = this.workspaceAccess.folders()
        if (!current()) throw new EditorCompanionError('cancelled')
        if (
          backend.connection.ownership !== 'managed' ||
          folders.length !== 1 ||
          primary === undefined ||
          primary.uri.scheme !== 'file'
        ) {
          this.phase = 'limited'
          this.reason = 'missing'
          this.scope = undefined
          return false
        }
        await this.service.start(
          backend.editorBridge,
          sessionId,
          randomUUID(),
          new EditorStateProvider(workspaceFolderId(primary), current),
        )
      }
      controller.signal.throwIfAborted()
      if (!this.service.active && !this.companion.active) return false
      this.status ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10)
      this.updateStatus()
      this.recoveryAttempts = 0
      this.reason = this.companion.active ? this.workspaceAccess.reason() : 'missing'
      this.phase = this.companion.active ? (this.reason === undefined ? 'ready' : 'waiting') : 'limited'
      return true
    } catch (error) {
      await Promise.all([this.service.stop(), this.companion.stop()])
      if (!controller.signal.aborted && !this.disposed) {
        this.phase = 'limited'
        this.reason =
          error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE'
            ? 'missing'
            : error instanceof AppError && error.code === 'BACKEND_BUSY'
              ? 'busy'
              : 'connection'
        if (!options.silent)
          void vscode.window.showInformationMessage(
            'Editor tools are temporarily unavailable. Your chat remains available. Open Settings → General → Editor integration to retry or repair.',
          )
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
  /** A user-initiated stop also suppresses automatic sharing until they turn it back on. */
  public stopByUser(): Promise<void> {
    this.suppressed = true
    this.phase = 'off'
    this.reason = undefined
    return this.stop().then(() => saveEditorPreferences({ enabled: false }))
  }
  public manage(): Promise<void> {
    return Promise.resolve(vscode.commands.executeCommand('dsh.openSettings')).then(() => undefined)
  }
  public install(): Promise<void> {
    return this.action('setup').then(() => undefined)
  }
  public async undoLastEdit(): Promise<void> {
    const entry = this.ledger.lastApplied()
    if (entry === undefined) {
      void vscode.window.showInformationMessage('No applied editor edit to undo.')
      return
    }
    const outcome = await revertEdit(entry, () => {
      if (!vscode.workspace.isTrusted) throw new Error('untrusted')
      const folders = vscode.workspace.workspaceFolders ?? []
      if (!folders.some((folder) => samePath(folder.uri.fsPath, entry.folderPath)))
        throw new Error('not-shared')
    })
    if (outcome === 'reverted') {
      this.ledger.settle(entry, 'reverted')
      this.editStatus?.hide()
    }
    void vscode.window.showInformationMessage(
      outcome === 'reverted'
        ? `Reverted edits to ${entry.relativePath}.`
        : outcome === 'unavailable'
          ? `Open the folder that contains ${entry.relativePath}, then undo again.`
          : `The file changed since the edit was applied. Use Ctrl+Z in the editor.`,
    )
  }
  public async dispose(): Promise<void> {
    this.preparing?.abort()
    this.disposed = true
    clearTimeout(this.editTimer)
    clearTimeout(this.recovery)
    for (const timer of this.flashTimers) clearTimeout(timer)
    this.flashTimers.clear()
    await this.stop()
    await this.syncOperation
    this.ledger.clear()
    await this.management.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
    this.status?.dispose()
    this.editStatus?.dispose()
    this.decoration?.dispose()
  }
  public prepareSession(sessionId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted)
      return Promise.reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError'),
      )
    this.deps.sessionNavigation.select(sessionId)
    // Editor tools already wait for their own binding and carry exec.signal.
    // Optional companion setup must not hold an ordinary prompt admission.
    if (readEditorPreferences().enabled && !this.disposed) void this.reconcile()
    return Promise.resolve()
  }
  public snapshot(): EditorIntegrationStatus {
    let backend: DshBackend | undefined
    try {
      backend = this.deps.backendService.requireBackend()
    } catch {
      /* Disconnected status stays available. */
    }
    const preferences = readEditorPreferences()
    const managed =
      backend !== undefined && this.currentBackend(backend) && backend.connection.ownership === 'managed'
    return {
      kind: 'editor.companion',
      preferences,
      phase: !preferences.enabled || this.suppressed ? 'off' : this.phase,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      ...(this.version === undefined ? {} : { version: this.version }),
      capabilities: this.capabilities,
      canInstall:
        managed &&
        vscode.workspace.isTrusted &&
        this.deps.context !== undefined &&
        this.deps.reconnect !== undefined &&
        !this.management.busy &&
        this.preparing === undefined,
      canRestart: managed,
      canUndo: this.ledger.lastApplied() !== undefined,
      ...(this.management.installationState === undefined
        ? {}
        : { installation: this.management.installationState }),
      canCancelInstall: this.preparing !== undefined || this.management.canCancelInstall,
      ...this.management.installationFailure,
      ...this.management.installationStatus,
      ...(this.preparing === undefined
        ? this.prerequisiteOutcome === undefined
          ? {}
          : { installation: this.prerequisiteOutcome }
        : { installation: 'preparing-dependencies' as const }),
    }
  }
  public async configure(change: Partial<EditorIntegrationPreferences>): Promise<EditorIntegrationStatus> {
    await saveEditorPreferences(change)
    this.suppressed = !readEditorPreferences().enabled
    await this.stop()
    await this.reconcile()
    return this.snapshot()
  }
  public async action(
    action:
      | 'retry'
      | 'setup'
      | 'cancel-install'
      | 'restart'
      | 'undo'
      | 'start-managed'
      | 'check-dependencies'
      | 'copy-pnpm-command'
      | 'open-pnpm-guide'
      | 'prepare-pnpm',
  ): Promise<EditorIntegrationStatus> {
    if (action === 'prepare-pnpm') {
      if (!this.snapshot().canInstall || !vscode.workspace.isTrusted) return this.snapshot()
      const backend = this.deps.backendService.requireBackend()
      const controller = new AbortController()
      this.preparing = controller
      this.prerequisiteOutcome = undefined
      try {
        await prepareCompanionPackageManager(controller.signal)
        controller.signal.throwIfAborted()
        if (!this.currentBackend(backend)) throw new DOMException('Connection changed', 'AbortError')
        await this.deps.reconnect?.(controller.signal)
        controller.signal.throwIfAborted()
        await this.management.refreshStatus(true)
      } catch {
        this.prerequisiteOutcome = controller.signal.aborted ? 'cancelled' : 'dependencies-failed'
      } finally {
        if (this.preparing === controller) this.preparing = undefined
      }
      return this.snapshot()
    }
    if (action === 'copy-pnpm-command') {
      await vscode.env.clipboard.writeText(PNPM_INSTALL_COMMAND)
      return this.snapshot()
    }
    if (action === 'open-pnpm-guide') {
      await vscode.env.openExternal(vscode.Uri.parse(PNPM_INSTALL_GUIDE))
      return this.snapshot()
    }
    if (action === 'check-dependencies') {
      await this.management.refreshStatus(true)
      return this.snapshot()
    }
    if (action === 'cancel-install') {
      this.preparing?.abort()
      await this.management.cancelInstallation()
      return this.snapshot()
    }
    if (action === 'undo') await this.undoLastEdit()
    else if (action === 'start-managed') {
      if (vscode.workspace.isTrusted) {
        await vscode.workspace
          .getConfiguration('dsh.connection')
          .update('mode', 'new-isolated', vscode.ConfigurationTarget.Workspace)
        await this.deps.reconnect?.()
      }
    } else if (action === 'restart') {
      if (this.snapshot().canRestart) await this.deps.reconnect?.()
    } else {
      if (action === 'retry') await this.management.recoverInstallation()
      if (action === 'retry' && this.workspaceAccess.reason() !== undefined) {
        this.workspaceAccess.reset()
        await this.workspaceAccess.request(AbortSignal.timeout(60_000)).catch((error: unknown) => {
          if (!(error instanceof EditorCompanionError)) throw error
        })
      }
      if (action === 'setup' && this.snapshot().canInstall) {
        this.prerequisiteOutcome = undefined
        this.phase = 'setup'
        this.reason = undefined
        try {
          // Explicit consent installs the shipped package through DSH's standard manager.
          await saveEditorPreferences({ autoSetup: true, enabled: true })
          this.suppressed = false
          await this.stop()
          if (!(await this.management.installBundled({ silent: true }))) {
            this.phase = this.management.installationState === 'installed' ? 'needs-restart' : 'limited'
            this.reason = this.management.installationState === 'installed' ? 'restart' : 'setup-failed'
            return this.snapshot()
          }
        } catch {
          this.phase = 'limited'
          this.reason = 'setup-failed'
          return this.snapshot()
        }
      }
      await this.reconcile()
    }
    return this.snapshot()
  }
  public async readStatus(): Promise<EditorIntegrationStatus> {
    await this.management.refreshStatus()
    return this.snapshot()
  }
  /** Serialize teardown/start across rapid selection changes and late installation acknowledgements. */
  private reconcile(): Promise<void> {
    this.syncRequested = true
    if (this.syncOperation !== undefined) return this.syncOperation
    const operation = Promise.resolve()
      .then(async () => {
        do {
          this.syncRequested = false
          if (this.disposed) break
          const sessionId = this.deps.sessionNavigation.activeSessionId
          if (this.scope !== undefined && this.scope.sessionId !== sessionId) await this.stop()
          await this.autoShare()
        } while (this.syncRequested)
      })
      .catch(() => {
        if (!this.disposed) {
          this.phase = 'limited'
          this.reason = 'connection'
        }
      })
    this.syncOperation = operation
    void operation.finally(() => {
      if (this.syncOperation === operation) this.syncOperation = undefined
    })
    return operation
  }
  private async autoShare(): Promise<void> {
    const preferences = readEditorPreferences()
    if (!preferences.enabled || this.suppressed || this.disposed) {
      this.phase = 'off'
      this.reason = undefined
      return
    }
    if (this.starting !== undefined || this.management.busy || this.service.active || this.companion.active)
      return
    let backend: DshBackend
    try {
      backend = this.deps.backendService.requireBackend()
    } catch {
      this.phase = 'waiting'
      this.reason = 'disconnected'
      return
    }
    if (
      preferences.autoSetup &&
      backend.connection.ownership === 'managed' &&
      vscode.workspace.isTrusted &&
      this.deps.context?.extensionUri !== undefined &&
      !this.checkedUpdates.has(backend) &&
      typeof backend.pluginBundles?.listBundles === 'function'
    ) {
      this.checkedUpdates.add(backend)
      // Only an already installed bundle is updated automatically. Missing packages
      // retain the explicit Install action, including migration from old --patch loading.
      const bundles = await backend.pluginBundles.listBundles(AbortSignal.timeout(10_000))
      if (!this.currentBackend(backend)) return
      if (
        bundles.some((bundle) => bundle.name === '@dsh-vscode/editor-bridge' && bundle.installed) &&
        (await companionNeedsUpdate(
          backend,
          vscode.Uri.joinPath(this.deps.context.extensionUri, 'resources').fsPath,
        ))
      ) {
        if (!this.currentBackend(backend)) return
        this.phase = 'setup'
        if (!(await this.management.installBundled({ silent: true }))) {
          this.phase = this.management.installationState === 'installed' ? 'needs-restart' : 'limited'
          this.reason = this.management.installationState === 'installed' ? 'restart' : 'setup-failed'
          if (this.management.installationState !== 'installed') await this.enable({ silent: true })
          return
        }
      }
    }
    if (this.deps.sessionNavigation.activeSessionId === undefined) {
      this.phase = 'waiting'
      this.reason = 'session'
      return
    }
    await this.enable({ silent: true })
  }
  /** A status entry replaces the per-edit notification: visible when wanted, never modal. */
  private showEditIndicator(applied: Applied): void {
    this.editStatus ??= vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9)
    this.editStatus.text = `${applied.saved === false ? '$(warning)' : '$(check)'} DSH edited ${applied.relativePath}${applied.saved === false ? ' · not saved' : ''} · Undo`
    this.editStatus.tooltip =
      applied.saved === false
        ? 'The edit applied, but saving failed. Use VS Code Save to retry saving; do not repeat the edit. Undo remains available.'
        : 'Undo the last agent edit'
    this.editStatus.command = 'dsh.undoEditorEdit'
    this.editStatus.show()
    this.flash(applied)
    clearTimeout(this.editTimer)
    // Collapse instead of vanishing, so Undo stays discoverable minutes later.
    this.editTimer = setTimeout(() => {
      if (this.editStatus === undefined) return
      this.editStatus.text =
        applied.saved === false ? '$(warning) DSH: save failed · Undo' : '$(history) DSH: undo last edit'
      if (applied.saved !== false) this.editStatus.tooltip = `Undo the edit to ${applied.relativePath}`
    }, 8_000)
  }
  /** A two-second wash over the touched lines, only where the file is already on screen. */
  private flash(applied: Applied): void {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === applied.uri.toString(),
    )
    if (editor === undefined) return
    this.decoration ??= vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    })
    const decoration = this.decoration
    const ranges = applied.lines.map(
      ([start, end]) => new vscode.Range(start - 1, 0, Math.max(start, end) - 1, 0),
    )
    editor.setDecorations(decoration, ranges)
    const timer = setTimeout(() => {
      this.flashTimers.delete(timer)
      if (!this.disposed) editor.setDecorations(decoration, [])
    }, 2_000)
    this.flashTimers.add(timer)
  }
  /** An interrupted grant heals itself; the status bar carries the state instead of a dialog. */
  private scheduleRecovery(): void {
    if (this.disposed || this.suppressed || this.recoveryAttempts >= 3) return
    clearTimeout(this.recovery)
    const wait = 2_000 * (this.recoveryAttempts + 1)
    this.recoveryAttempts += 1
    this.recovery = setTimeout(() => {
      try {
        if (this.deps.coordinator.getState().kind === 'connected') void this.reconcile()
      } catch {
        return
      }
    }, wait)
  }
  /** Exact root, a session in a subfolder, or a session above the root all stay shareable. */
  private folderFor(cwd: string | undefined): vscode.WorkspaceFolder | undefined {
    if (cwd === undefined) return undefined
    const folders = vscode.workspace.workspaceFolders ?? []
    const exact = folders.find((folder) => samePath(folder.uri.fsPath, cwd))
    if (exact !== undefined) return exact
    const related = folders
      .filter((folder) => isPathWithin(folder.uri.fsPath, cwd) || isPathWithin(cwd, folder.uri.fsPath))
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)
    return related[0]
  }
  private updateStatus(): void {
    if (this.status === undefined) return
    if (!this.service.active && !this.companion.active) {
      this.status.hide()
      return
    }
    this.status.text = this.companion.active
      ? '$(broadcast) DSH: Editor tools on'
      : '$(broadcast) DSH: Editor metadata on'
    this.status.tooltip = this.companion.active
      ? `Editor tools on: ${this.capabilities.join(', ')}. Edits are undoable. Click to open editor integration settings.`
      : 'Editor metadata is on. Click to open editor integration settings.'
    this.status.command = 'dsh.manageEditorCompanion'
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
