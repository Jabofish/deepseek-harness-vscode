import {
  AppError,
  type DshBackend,
  type OptionalPluginBundle,
  type OptionalPluginBundleSnapshot,
  type PluginBundleChangeResult,
} from '@dsh-vscode/domain'

/** Application boundary for RC2's optional, profile-wide bundle controls. */
export class PluginBundleUseCases {
  public constructor(private readonly backend: DshBackend) {}

  public async list(signal?: AbortSignal): Promise<OptionalPluginBundleSnapshot> {
    signal?.throwIfAborted()
    const repository = this.backend.pluginBundles
    if (repository === undefined) return { available: false, bundles: [] }
    const inventory = await this.backend.plugins.inventory(signal)
    signal?.throwIfAborted()
    if (inventory.managementAvailable !== true) return { available: false, bundles: [] }
    return { available: true, bundles: await repository.listOptionalBundles(signal) }
  }

  public async setEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal,
    confirmEnable?: (bundle: OptionalPluginBundle) => Promise<boolean>,
  ): Promise<PluginBundleChangeResult> {
    signal?.throwIfAborted()
    if (name.trim() === '' || name.length > 512)
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'A current optional DSH bundle name is required.',
        retryable: false,
      })
    const repository = this.backend.pluginBundles
    if (repository === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Optional bundle controls are not available in this DSH version.',
        retryable: false,
      })
    const inventory = await this.backend.plugins.inventory(signal)
    signal?.throwIfAborted()
    if (inventory.managementAvailable !== true)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'DSH did not report an available profile Plugin Manager.',
        retryable: false,
      })
    const bundles = await repository.listOptionalBundles(signal)
    signal?.throwIfAborted()
    // Names are always discovered from the live RC2 catalog. `installed` is deliberately
    // not a condition: DSH itself supplies optional bundles outside profile dependencies.
    const selected = bundles.find((bundle) => bundle.name === name)
    if (selected === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The selected optional bundle is no longer available in the current DSH profile.',
        retryable: false,
      })
    if (enabled) {
      if (confirmEnable === undefined)
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Enabling an optional DSH bundle requires explicit Host confirmation.',
          retryable: false,
        })
      if (!(await confirmEnable(selected))) return { name, changed: false, application: 'cancelled', enabled }
      signal?.throwIfAborted()
    }
    return repository.setBundleEnabled(name, enabled, signal)
  }
}
