import { randomUUID } from 'node:crypto'
import * as vscode from 'vscode'
import {
  AppError,
  isLoopbackEndpoint,
  type DshBackend,
  type EditorIntegrationStatus,
  type PluginBundleChangeResult,
  type PluginBundleRepository,
} from '@dsh-vscode/domain'
import {
  EDITOR_COMPANION_PACKAGE,
  cacheCompanionArchive,
  listCompanionArchives,
  type CompanionArchive,
} from './companion-archive.js'

interface Dependencies {
  readonly backend: () => DshBackend
  readonly current: (backend: DshBackend) => boolean
  readonly extensionUri: vscode.Uri | undefined
  readonly storageUri: vscode.Uri | undefined
  readonly reconnect: ((signal?: AbortSignal) => Promise<unknown>) | undefined
  readonly active: () => boolean
  readonly enable: () => Promise<boolean>
  readonly stop: () => Promise<void>
  readonly halt: () => Promise<void>
  readonly undo: () => Promise<void>
  readonly checkPackageManager?: () => Promise<NonNullable<EditorIntegrationStatus['packageManager']>>
}
interface RecoveryArchive extends CompanionArchive {
  readonly enabled: boolean
}
/** All installation and lifecycle actions originate in native user controls. */
export class EditorCompanionManagement {
  private observed: Pick<EditorIntegrationStatus, 'installed' | 'packageManager'> = {}
  private observedBackend: DshBackend | undefined
  private observedAt = 0
  private refreshing: Promise<void> | undefined
  public get installationStatus(): typeof this.observed {
    return this.observedBackend !== undefined && this.deps.current(this.observedBackend) ? this.observed : {}
  }
  public async refreshStatus(force = false): Promise<void> {
    if (this.refreshing !== undefined) return this.refreshing
    if (
      this.busy ||
      (!force &&
        this.observedBackend !== undefined &&
        this.deps.current(this.observedBackend) &&
        Date.now() - this.observedAt < 30_000)
    )
      return
    const refresh = (async (): Promise<void> => {
      try {
        const backend = this.deps.backend()
        if (!this.deps.current(backend) || typeof backend.pluginBundles?.listBundles !== 'function') return
        const bundles = await backend.pluginBundles.listBundles(AbortSignal.timeout(10_000))
        if (!this.deps.current(backend)) return
        const installed = bundles.some(
          (bundle) => bundle.name === EDITOR_COMPANION_PACKAGE && bundle.installed,
        )
        const packageManager =
          backend.connection.ownership === 'managed' && vscode.workspace.isTrusted
            ? await this.deps.checkPackageManager?.()
            : undefined
        if (!this.deps.current(backend)) return
        this.observedBackend = backend
        this.observedAt = Date.now()
        this.observed = { installed, ...(packageManager === undefined ? {} : { packageManager }) }
        if (
          packageManager === 'ready' &&
          this.failure.installationFailureKind === 'pnpm-missing' &&
          this.installPhase === 'failed'
        ) {
          this.failure = {}
          this.installPhase = undefined
        }
      } catch {
        this.observedAt = 0
        this.observed = {}
      }
    })()
    this.refreshing = refresh
    try {
      await refresh
    } finally {
      if (this.refreshing === refresh) this.refreshing = undefined
    }
  }
  private installPhase: EditorIntegrationStatus['installation']
  private installBackend: DshBackend | undefined
  private failure: Pick<EditorIntegrationStatus, 'installationErrorCode' | 'installationFailureKind'> = {}
  public get installationFailure(): typeof this.failure {
    return this.installBackend !== undefined && !this.deps.current(this.installBackend) ? {} : this.failure
  }
  public get installationState(): EditorIntegrationStatus['installation'] {
    if (this.installBackend !== undefined && !this.deps.current(this.installBackend)) return undefined
    return this.installPhase
  }
  public get canCancelInstall(): boolean {
    const phase = this.installationState
    return this.busy && (phase === 'installing' || phase === 'unknown')
  }
  private controller: AbortController | undefined
  private installation:
    { readonly repository: PluginBundleRepository; readonly requestId: string } | undefined
  private operation: Promise<void> | undefined
  private uncertain:
    | {
        readonly backend: DshBackend
        readonly repository: PluginBundleRepository
        readonly requestId: string
        readonly backup?: RecoveryArchive
        readonly restoreEnabled?: boolean
      }
    | undefined
  public constructor(private readonly deps: Dependencies) {}
  public get busy(): boolean {
    return (
      this.operation !== undefined ||
      (this.uncertain !== undefined && this.deps.current(this.uncertain.backend))
    )
  }
  public async manage(): Promise<void> {
    try {
      const backend = this.available(undefined, false)
      const repository = backend.pluginBundles
      if (repository === undefined) throw new Error('Unavailable')
      await this.recover(backend)
      const bundles = await repository.listBundles(AbortSignal.timeout(10_000))
      if (!this.deps.current(backend)) return
      const bundle = bundles.find((item) => item.name === EDITOR_COMPANION_PACKAGE)
      let status = bundle?.installed
        ? `Installed ${bundle.version ?? ''}; ${bundle.enabled ? 'enabled' : 'disabled'}`
        : 'Not installed'
      if (bundle?.enabled) {
        try {
          const description = await backend.editorBridge?.companion?.describe(AbortSignal.timeout(5_000))
          if (description !== undefined)
            status = `Ready v${description.packageVersion}; protocol ${description.protocolVersion}`
        } catch {
          status += '; tool protocol unavailable (refresh or reconnect)'
        }
      }
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: this.deps.active()
              ? 'Stop sharing editor tools'
              : 'Share editor tools with current session',
            action: 'sharing',
          },
          { label: 'Undo the last applied edit', action: 'undo' },
          ...(backend.connection.ownership === 'managed'
            ? [
                { label: 'Install the bundled companion', action: 'install' },
                { label: 'Install another companion bundle (upgrade or rollback)', action: 'file' },
                { label: 'Restore a cached companion version', action: 'restore' },
                ...(this.uncertain !== undefined && this.deps.current(this.uncertain.backend)
                  ? [{ label: 'Cancel the pending installation', action: 'cancel' }]
                  : []),
                ...(bundle?.installed
                  ? [
                      { label: bundle.enabled ? 'Disable companion' : 'Enable companion', action: 'toggle' },
                      ...(bundle.removable ? [{ label: 'Uninstall companion', action: 'remove' }] : []),
                    ]
                  : []),
              ]
            : []),
          { label: 'Refresh status', action: 'refresh' },
        ],
        {
          title: `DSH Editor Companion — ${status}`,
          placeHolder: this.deps.active()
            ? 'Sharing is active for the selected session; changing session or disconnecting revokes it.'
            : 'Sharing turns on automatically for the selected session. Use Stop to switch it off.',
        },
      )
      if (choice === undefined || !this.deps.current(backend)) return
      switch (choice.action) {
        case 'sharing':
          if (this.deps.active()) await this.deps.stop()
          else await this.deps.enable()
          return
        case 'undo':
          await this.deps.undo()
          return
        case 'install':
          await this.installBundled()
          return
        case 'file': {
          const files = await vscode.window.showOpenDialog({
            title: 'Select a trusted DSH editor companion bundle',
            canSelectMany: false,
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'Companion bundle': ['tgz'] },
          })
          const file = files?.[0]
          if (file !== undefined && this.deps.current(backend)) await this.install(file.fsPath)
          return
        }
        case 'restore': {
          const archives =
            this.deps.storageUri === undefined ? [] : await listCompanionArchives(this.deps.storageUri.fsPath)
          const previous = await vscode.window.showQuickPick(
            archives.map((archive) => ({ label: `Editor companion v${archive.version}`, archive })),
            { title: 'Restore a cached editor companion bundle' },
          )
          if (previous !== undefined && this.deps.current(backend)) await this.install(previous.archive.file)
          return
        }
        case 'cancel':
          this.cancel()
          return
        case 'toggle':
          if (bundle !== undefined)
            await this.mutate(backend, () => repository.setBundleEnabled(bundle.name, !bundle.enabled))
          return
        case 'remove': {
          const answer = await vscode.window.showWarningMessage(
            'Uninstall the DSH editor companion?',
            { modal: true, detail: 'Editor sharing will stop. Your files and DSH sessions will remain.' },
            'Uninstall',
          )
          if (answer === 'Uninstall' && bundle !== undefined)
            await this.mutate(backend, () => repository.removeBundle(bundle.name))
          return
        }
        case 'refresh':
          await this.manage()
          return
      }
    } catch {
      void vscode.window.showErrorMessage(
        'The editor companion manager is unavailable. Connect a local DSH with a compatible plugin manager and try again.',
      )
    }
  }
  public async installBundled(options: { silent?: boolean } = {}): Promise<boolean> {
    if (this.deps.extensionUri === undefined) {
      if (!options.silent)
        void vscode.window.showErrorMessage(
          'Build the extension package before installing its companion bundle.',
        )
      return false
    }
    return this.install(
      vscode.Uri.joinPath(this.deps.extensionUri, 'resources', 'editor-companion.tgz').fsPath,
      options,
    )
  }
  public cancel(keepResponse = false): void {
    if (this.installPhase === 'installed') return
    if (this.controller !== undefined || this.uncertain !== undefined) this.installPhase = 'cancelling'
    if (!keepResponse || this.installation === undefined) this.controller?.abort()
    if (this.installation !== undefined)
      void this.installation.repository
        .cancelInstall(this.installation.requestId, AbortSignal.timeout(5_000))
        .catch(() => {
          if (this.installPhase === 'cancelling') this.installPhase = 'unknown'
        })
    else if (this.uncertain !== undefined && this.deps.current(this.uncertain.backend))
      void this.uncertain.repository
        .cancelInstall(this.uncertain.requestId, AbortSignal.timeout(5_000))
        .catch(() => {
          if (this.installPhase === 'cancelling') this.installPhase = 'unknown'
        })
  }
  public async cancelInstallation(): Promise<void> {
    this.cancel(true)
    if (
      this.operation === undefined &&
      this.uncertain !== undefined &&
      this.deps.current(this.uncertain.backend)
    )
      await this.recover(this.uncertain.backend)
  }
  public async recoverInstallation(): Promise<void> {
    if (this.uncertain !== undefined && this.deps.current(this.uncertain.backend))
      await this.recover(this.uncertain.backend)
  }
  public async dispose(): Promise<void> {
    this.cancel()
    await this.operation
  }
  private async install(file: string, options: { silent?: boolean } = {}): Promise<boolean> {
    if (this.busy) {
      if (!options.silent)
        void vscode.window.showInformationMessage(
          'An editor companion change is in progress or awaiting a confirmed outcome. Refresh companion status before starting another change.',
        )
      return false
    }
    const operation = this.runInstall(file, options.silent === true)
    const tracked = operation.then(() => undefined)
    this.operation = tracked
    try {
      return await operation
    } finally {
      if (this.operation === tracked) this.operation = undefined
    }
  }
  private async runInstall(file: string, silent: boolean): Promise<boolean> {
    this.installPhase = 'installing'
    this.failure = {}
    const controller = new AbortController()
    this.controller = controller
    try {
      const backend = this.available()
      this.installBackend = backend
      const packageManager = await this.deps.checkPackageManager?.()
      controller.signal.throwIfAborted()
      if (!this.deps.current(backend)) return false
      if (packageManager !== undefined) {
        if (this.observedBackend !== backend) this.observed = {}
        this.observedBackend = backend
        this.observed = { ...this.installationStatus, packageManager }
        if (packageManager !== 'ready') {
          this.installPhase = 'failed'
          this.failure = { installationFailureKind: 'pnpm-missing' }
          return false
        }
      }
      const repository = backend.pluginBundles
      if (repository === undefined) throw new Error('Unavailable')
      const storage = this.deps.storageUri
      if (storage === undefined) throw new Error('Companion artifact storage is unavailable')
      const previousArchives = await listCompanionArchives(storage.fsPath)
      const archive = await cacheCompanionArchive(file, storage.fsPath)
      const installed = (await repository.listBundles(controller.signal)).find(
        (bundle) => bundle.name === EDITOR_COMPANION_PACKAGE && bundle.installed,
      )
      this.observedBackend = backend
      this.observed = { ...this.observed, installed: installed !== undefined }
      let backup: RecoveryArchive | undefined
      if (installed !== undefined) {
        if (!installed.removable || installed.readOnlyReason !== undefined)
          throw new Error('The existing bundle cannot be replaced')
        const candidates = previousArchives.filter((candidate) => candidate.version === installed.version)
        const cached = candidates.length === 1 ? candidates[0] : undefined
        if (cached !== undefined) backup = { ...cached, enabled: installed.enabled }
      }
      if (!this.deps.current(backend)) return false
      if (!silent) {
        const consent = await vscode.window.showWarningMessage(
          `Install editor companion v${archive.version}?`,
          {
            modal: true,
            detail:
              'This installs code into the connected extension-managed DSH profile. Install only a trusted bundle. Existing editor access will be revoked. Replacing a version keeps a recovery archive and restores it after a confirmed installation failure or cancellation. Sharing must be enabled again.',
          },
          'Install',
        )
        if (consent !== 'Install') {
          this.installPhase = 'cancelled'
          return false
        }
      }
      controller.signal.throwIfAborted()
      this.available(backend)
      await this.deps.halt()
      const install = async (cancellation: { dispose(): void }): Promise<boolean> => {
        const requestId = randomUUID()
        this.installation = { repository, requestId }
        try {
          this.available(backend)
          // DSH's native add operation also replaces an existing tarball and rolls
          // its manifest/lockfile back on cancellation. Never uninstall first:
          // removal has no request identity or cancellation/recovery channel.
          let result: PluginBundleChangeResult | null
          this.uncertain = { backend, repository, requestId, ...(backup === undefined ? {} : { backup }) }
          try {
            result = await repository.installBundle(
              archive.file,
              { requestId, saveExact: true, approvedBuilds: [] },
              controller.signal,
            )
          } catch (error) {
            if (error instanceof AppError && error.code === 'PLUGIN_INSTALL_NOT_STARTED') {
              this.uncertain = undefined
              if (backup !== undefined) await this.restore(backend, repository, backup)
              throw error
            }
            if (controller.signal.aborted)
              await repository.cancelInstall(requestId, AbortSignal.timeout(5_000)).catch(() => undefined)
            result = await repository.waitForInstall(requestId, AbortSignal.timeout(20_000))
          }
          if (!this.deps.current(backend)) return false
          if (result === null) {
            if (!silent)
              void vscode.window.showWarningMessage(
                'The installation outcome is not yet known. Refresh the companion status before trying another installation.',
              )
            return false
          }
          this.uncertain = undefined
          if (backup !== undefined && (result.application === 'failed' || result.application === 'cancelled'))
            await this.restore(backend, repository, backup)
          await this.result(backend, result, silent)
          return result.application === 'applied' || result.application === 'restart-required'
        } finally {
          cancellation.dispose()
          this.installation = undefined
        }
      }
      if (silent) return await install({ dispose() {} })
      return await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Installing DSH editor companion v${archive.version}`,
          cancellable: true,
        },
        async (_progress, token) => install(token.onCancellationRequested(() => this.cancel(true))),
      )
    } catch {
      if (this.installationState !== 'installed')
        this.installPhase =
          this.uncertain !== undefined ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'failed'
      if (!controller.signal.aborted && !silent)
        void vscode.window.showErrorMessage(
          this.uncertain !== undefined
            ? 'The installation outcome is unknown. Refresh companion status to recover the original installation before starting another change.'
            : 'The companion bundle could not be installed. Check its package identity, compatibility and dependency availability, then refresh the companion status.',
        )
      return false
    } finally {
      if (this.uncertain !== undefined) this.installPhase = 'unknown'
      if (this.controller === controller) this.controller = undefined
    }
  }
  private async recover(backend: DshBackend): Promise<void> {
    const pending = this.uncertain
    if (pending === undefined || this.operation !== undefined) return
    if (pending.backend !== backend || !this.deps.current(backend)) {
      this.uncertain = undefined
      return
    }
    let result: PluginBundleChangeResult | null
    try {
      result = await pending.repository.waitForInstall(pending.requestId, AbortSignal.timeout(5_000))
    } catch {
      if (this.deps.current(backend)) this.installPhase = 'unknown'
      return
    }
    if (result === null || !this.deps.current(backend)) {
      if (this.deps.current(backend)) this.installPhase = 'unknown'
      return
    }
    if (
      pending.restoreEnabled === false &&
      (result.application === 'applied' || result.application === 'restart-required')
    ) {
      const disabled = await pending.repository.setBundleEnabled(
        EDITOR_COMPANION_PACKAGE,
        false,
        AbortSignal.timeout(10_000),
      )
      if (disabled.application !== 'applied' && disabled.application !== 'restart-required')
        throw new Error('Recovery state not restored')
    }
    this.uncertain = undefined
    if (
      pending.backup !== undefined &&
      (result.application === 'failed' || result.application === 'cancelled')
    )
      await this.restore(backend, pending.repository, pending.backup)
    await this.result(backend, result)
  }
  private async restore(
    backend: DshBackend,
    repository: PluginBundleRepository,
    archive: RecoveryArchive,
  ): Promise<void> {
    if (!this.deps.current(backend)) return
    const requestId = randomUUID()
    const signal = AbortSignal.timeout(60_000)
    try {
      let result: PluginBundleChangeResult | null
      this.uncertain = { backend, repository, requestId, restoreEnabled: archive.enabled }
      try {
        result = await repository.installBundle(
          archive.file,
          { requestId, saveExact: true, approvedBuilds: [] },
          signal,
        )
      } catch (error) {
        if (error instanceof AppError && error.code === 'PLUGIN_INSTALL_NOT_STARTED') {
          this.uncertain = undefined
          throw error
        }
        result = await repository.waitForInstall(requestId, signal)
      }
      if (result === null || (result.application !== 'applied' && result.application !== 'restart-required'))
        throw new Error('Recovery installation failed')
      if (!archive.enabled && this.deps.current(backend)) {
        const disabled = await repository.setBundleEnabled(EDITOR_COMPANION_PACKAGE, false, signal)
        if (disabled.application !== 'applied' && disabled.application !== 'restart-required')
          throw new Error('Recovery state not restored')
      }
      this.uncertain = undefined
      if (this.deps.current(backend)) {
        void vscode.window.showInformationMessage(
          `The previous editor companion v${archive.version} was restored${result.application === 'restart-required' ? '; reconnect to activate it' : ''}.`,
        )
      }
    } catch {
      if (this.deps.current(backend))
        void vscode.window.showErrorMessage(
          'Automatic recovery could not be confirmed. Refresh companion status and use Restore a previously installed companion version before enabling sharing.',
        )
    }
  }
  private async mutate(backend: DshBackend, change: () => Promise<PluginBundleChangeResult>): Promise<void> {
    this.available(backend)
    if (this.busy) {
      void vscode.window.showWarningMessage(
        'Wait for the current companion change to settle, then refresh status.',
      )
      return
    }
    const operation = (async (): Promise<void> => {
      await this.deps.halt()
      this.available(backend)
      await this.result(backend, await change())
    })()
    this.operation = operation
    try {
      await operation
    } finally {
      if (this.operation === operation) this.operation = undefined
    }
  }
  private async result(backend: DshBackend, result: PluginBundleChangeResult, silent = false): Promise<void> {
    if (!this.deps.current(backend)) return
    this.observedAt = 0
    if (
      result.stage !== 'remove' &&
      (result.application === 'applied' || result.application === 'restart-required')
    )
      this.observed = { ...this.observed, installed: true }
    this.failure = {
      ...(result.errorCode === undefined ? {} : { installationErrorCode: result.errorCode }),
      ...(result.failureKind === undefined ? {} : { installationFailureKind: result.failureKind }),
    }
    this.installPhase =
      result.application === 'applied' || result.application === 'restart-required'
        ? 'installed'
        : result.application === 'cancelled'
          ? 'cancelled'
          : 'failed'
    if (result.application === 'restart-required') {
      if (silent) {
        await this.deps.reconnect?.()
        return
      }
      const choice = await vscode.window.showInformationMessage(
        'The editor companion change requires reconnecting the extension-managed DSH.',
        'Reconnect',
      )
      if (choice === 'Reconnect' && this.deps.current(backend)) await this.deps.reconnect?.()
      return
    }
    if (silent) return
    if (
      result.application === 'failed' &&
      (result.errorCode === 'stop-profile' || result.errorCode === 'bundle-in-use')
    )
      void vscode.window.showErrorMessage(
        'DSH requires offline profile maintenance for this change. Disconnect the extension-managed runtime, use the DSH plugin CLI with that same home/profile, then reconnect. No external process has been stopped.',
      )
    else if (result.application === 'failed')
      void vscode.window.showErrorMessage(
        `Editor companion change failed (${result.errorCode ?? result.failureKind ?? 'operation-error'}). Check that DSH can run pnpm in its environment, then refresh status before retrying.`,
      )
    else if (result.application === 'cancelled')
      void vscode.window.showInformationMessage('Editor companion installation was cancelled.')
    else if (result.application === 'overridden')
      void vscode.window.showWarningMessage(
        'The companion change is overridden by another profile entry. Inspect DSH plugin settings before sharing access.',
      )
    else
      void vscode.window.showInformationMessage(
        'Editor companion change applied. Editor tools will turn on with the next session.',
      )
  }
  private available(expected?: DshBackend, mutation = true): DshBackend {
    const backend = this.deps.backend()
    if (
      (expected !== undefined && backend !== expected) ||
      !this.deps.current(backend) ||
      !vscode.workspace.isTrusted ||
      (mutation && backend.connection.ownership !== 'managed') ||
      !isLoopbackEndpoint(backend.connection.endpoint) ||
      backend.editorBridge === undefined
    )
      throw new Error('Unavailable')
    return backend
  }
}
