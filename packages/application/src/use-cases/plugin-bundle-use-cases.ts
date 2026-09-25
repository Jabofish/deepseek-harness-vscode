import {
  AppError,
  type PluginBundleChangeResult,
  type PluginInspectProblem,
  type PluginInstallCancellation,
  type PluginManagerBundle,
  type PluginRegistry,
  type PluginRegistryCatalog,
  type PluginSpecInspection,
  type PluginManagerSnapshot,
} from '@dsh-vscode/domain'
import type { DshBackend } from '@dsh-vscode/domain'

export type PluginBundleEnableConfirmation = (bundle: PluginManagerBundle) => Promise<boolean>
export type PluginBundleRemoveConfirmation = (bundle: PluginManagerBundle) => Promise<boolean>
export type PluginInstallConfirmation = (spec: string, inspection: PluginSpecInspection) => Promise<boolean>
export type PluginBuildApprovalConfirmation = (packages: readonly string[]) => Promise<boolean>

/** Application boundary for the exact RC2 profile Plugin Manager. */
export class PluginBundleUseCases {
  public constructor(private readonly backend: DshBackend) {}

  public async list(signal?: AbortSignal): Promise<PluginManagerSnapshot> {
    const repository = await this.availableRepository(signal, false)
    if (repository === undefined) return { available: false, bundles: [], plugins: [] }
    const [bundles, plugins] = await Promise.all([
      repository.listBundles(signal),
      repository.listPlugins(signal),
    ])
    signal?.throwIfAborted()
    return { available: true, bundles, plugins }
  }

  public async registries(signal?: AbortSignal): Promise<PluginRegistryCatalog | undefined> {
    const repository = await this.availableRepository(signal, false)
    return repository === undefined ? undefined : repository.registries(signal)
  }

  public async inspect(
    spec: string,
    registry?: PluginRegistry,
    signal?: AbortSignal,
  ): Promise<PluginSpecInspection> {
    const repository = await this.availableRepository(signal, true)
    return repository.inspect(spec, registry, signal)
  }

  public async setEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal,
    confirmEnable?: PluginBundleEnableConfirmation,
  ): Promise<PluginBundleChangeResult> {
    const repository = await this.availableRepository(signal, true)
    const bundles = await repository.listBundles(signal)
    signal?.throwIfAborted()
    const selected = bundles.find((bundle) => bundle.name === name)
    if (selected === undefined)
      throw unavailable('The selected bundle is no longer present in the current DSH profile.')
    if (selected.readOnlyReason !== undefined)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'DSH protects this bundle from profile changes.',
        retryable: false,
      })
    if (enabled) {
      if (confirmEnable === undefined)
        throw permissionRequired('Enabling a DSH bundle requires Host confirmation.')
      if (!(await confirmEnable(selected)))
        return { name, changed: false, application: 'cancelled', enabled, stage: 'enable' }
      signal?.throwIfAborted()
    }
    return repository.setBundleEnabled(name, enabled, signal)
  }

  public async setPluginEnabled(
    entryId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult> {
    const repository = await this.availableRepository(signal, true)
    const plugins = await repository.listPlugins(signal)
    signal?.throwIfAborted()
    const selected = plugins.find((plugin) => plugin.entryId === entryId)
    if (selected === undefined) throw unavailable('The selected plugin entry is no longer available.')
    if (selected.readOnlyReason !== undefined)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'DSH protects this plugin entry from profile changes.',
        retryable: false,
      })
    return repository.setPluginEnabled(entryId, enabled, signal)
  }

  public async install(
    spec: string,
    requestId: string,
    registry: PluginRegistry | undefined,
    approvedBuilds: readonly string[] | undefined,
    signal: AbortSignal,
    confirmInstall?: PluginInstallConfirmation,
    confirmBuilds?: PluginBuildApprovalConfirmation,
  ): Promise<PluginBundleChangeResult> {
    const repository = await this.availableRepository(signal, true)
    const inspection = await repository.inspect(spec, registry, signal)
    signal.throwIfAborted()
    if (inspection.status === 'refused') throw inspectionFailure(inspection.problem)
    if (inspection.bundle === false) throw inspectionFailure('not-a-bundle')
    if (confirmInstall === undefined)
      throw permissionRequired('Installing a DSH bundle requires Host confirmation.')
    if (!(await confirmInstall(spec, inspection)))
      return { name: inspection.name ?? 'plugin', changed: false, application: 'cancelled', stage: 'install' }
    signal.throwIfAborted()
    if (approvedBuilds !== undefined && approvedBuilds.length > 0) {
      if (confirmBuilds === undefined)
        throw permissionRequired('Allowing dependency build scripts requires Host confirmation.')
      if (!(await confirmBuilds(approvedBuilds)))
        return {
          name: inspection.name ?? 'plugin',
          changed: false,
          application: 'cancelled',
          stage: 'install',
        }
      signal.throwIfAborted()
    }

    // The Webview request can be cancelled or disposed while pnpm is running. RC2 owns the process and
    // file restoration, so tell its request-scoped cancellation Remote before relinquishing this call.
    const cancelUpstream = (): void => {
      void repository.cancelInstall(requestId).catch(() => undefined)
    }
    signal.addEventListener('abort', cancelUpstream, { once: true })
    try {
      return await repository.installBundle(
        spec,
        {
          requestId,
          ...(registry === undefined ? {} : { registry }),
          ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
        },
        signal,
      )
    } finally {
      signal.removeEventListener('abort', cancelUpstream)
    }
  }

  public async cancelInstall(requestId: string, signal?: AbortSignal): Promise<PluginInstallCancellation> {
    const repository = await this.availableRepository(signal, true)
    return repository.cancelInstall(requestId, signal)
  }

  public async remove(
    name: string,
    signal?: AbortSignal,
    confirmRemove?: PluginBundleRemoveConfirmation,
  ): Promise<PluginBundleChangeResult> {
    const repository = await this.availableRepository(signal, true)
    const bundles = await repository.listBundles(signal)
    signal?.throwIfAborted()
    const selected = bundles.find((bundle) => bundle.name === name)
    if (selected === undefined || !selected.removable)
      throw unavailable('This bundle cannot be removed from the current DSH profile.')
    if (confirmRemove === undefined) throw permissionRequired('Removing a DSH bundle requires confirmation.')
    if (!(await confirmRemove(selected)))
      return { name, changed: false, application: 'cancelled', stage: 'remove' }
    signal?.throwIfAborted()
    return repository.removeBundle(name, signal)
  }

  private async availableRepository(
    signal: AbortSignal | undefined,
    required: true,
  ): Promise<NonNullable<DshBackend['pluginBundles']>>
  private async availableRepository(
    signal: AbortSignal | undefined,
    required: false,
  ): Promise<DshBackend['pluginBundles'] | undefined>
  private async availableRepository(
    signal: AbortSignal | undefined,
    required: boolean,
  ): Promise<DshBackend['pluginBundles'] | undefined> {
    signal?.throwIfAborted()
    const repository = this.backend.pluginBundles
    if (repository === undefined) {
      if (required) throw unavailable('Plugin management is not supported by this DSH version.')
      return undefined
    }
    const inventory = await this.backend.plugins.inventory(signal)
    signal?.throwIfAborted()
    if (inventory.managementAvailable !== true) {
      if (required) throw unavailable('DSH did not report an available profile Plugin Manager.')
      return undefined
    }
    return repository
  }
}

function inspectionFailure(problem: PluginInspectProblem): AppError {
  const messages: Record<PluginInspectProblem, string> = {
    'invalid-spec': 'The package specification is invalid.',
    'already-installed': 'This package is already present in the DSH profile.',
    'not-found': 'The package or version was not found in the selected registry.',
    'not-a-package': 'The selected item does not contain a readable package manifest.',
    'not-a-bundle': 'This package does not declare a DSH plugin bundle.',
    network: 'The package registry could not be reached.',
    unknown: 'DSH could not inspect this package.',
  }
  return unavailable(messages[problem] ?? 'DSH could not inspect this package.')
}

function unavailable(message: string): AppError {
  return new AppError({ code: 'CAPABILITY_UNAVAILABLE', message, retryable: true })
}

function permissionRequired(message: string): AppError {
  return new AppError({ code: 'PERMISSION_DENIED', message, retryable: false })
}
