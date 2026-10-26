import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type {
  DshBackend,
  ManagedPluginEntry,
  PluginBundleRepository,
  PluginManagerBundle,
  PluginSpecInspection,
} from '@dsh-vscode/domain'
import { PluginBundleUseCases } from './plugin-bundle-use-cases.js'

type PluginBundleMocks = {
  readonly listBundles: Mock<PluginBundleRepository['listBundles']>
  readonly listPlugins: Mock<PluginBundleRepository['listPlugins']>
  readonly registries: Mock<PluginBundleRepository['registries']>
  readonly inspect: Mock<PluginBundleRepository['inspect']>
  readonly installBundle: Mock<PluginBundleRepository['installBundle']>
  readonly waitForInstall: Mock<PluginBundleRepository['waitForInstall']>
  readonly cancelInstall: Mock<PluginBundleRepository['cancelInstall']>
  readonly removeBundle: Mock<PluginBundleRepository['removeBundle']>
  readonly setPluginEnabled: Mock<PluginBundleRepository['setPluginEnabled']>
  readonly setBundleEnabled: Mock<PluginBundleRepository['setBundleEnabled']>
}

type UseCaseFixture = {
  readonly useCases: PluginBundleUseCases
  readonly inventory: Mock<DshBackend['plugins']['inventory']>
  readonly mocks: PluginBundleMocks
}

const bundle: PluginManagerBundle = {
  name: '@dsh-community/review-layer',
  enabled: false,
  installed: false,
  optional: true,
  removable: false,
  rows: [],
  overrides: [],
}
const plugin: ManagedPluginEntry = {
  entryId: 'review:extension',
  moduleName: '@dsh-community/review-layer/extension',
  enabled: true,
  fiberPhase: 'active',
}
const inspection: PluginSpecInspection = {
  status: 'accepted',
  kind: 'registry',
  name: bundle.name,
  version: '1.0.0',
  bundle: true,
  registry: null,
}

function useCases(
  options: { readonly available?: boolean; readonly hasRepository?: boolean } = {},
): UseCaseFixture {
  const mocks: PluginBundleMocks = {
    listBundles: vi.fn<PluginBundleRepository['listBundles']>(() => Promise.resolve([bundle])),
    listPlugins: vi.fn<PluginBundleRepository['listPlugins']>(() => Promise.resolve([plugin])),
    registries: vi.fn<PluginBundleRepository['registries']>(() =>
      Promise.resolve({ registry: null, fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' }),
    ),
    inspect: vi.fn<PluginBundleRepository['inspect']>(() => Promise.resolve(inspection)),
    installBundle: vi.fn<PluginBundleRepository['installBundle']>(() =>
      Promise.resolve({
        name: bundle.name,
        changed: true,
        application: 'applied' as const,
        stage: 'install' as const,
      }),
    ),
    waitForInstall: vi.fn<PluginBundleRepository['waitForInstall']>(() =>
      Promise.resolve({ name: bundle.name, changed: true, application: 'applied', stage: 'install' }),
    ),
    cancelInstall: vi.fn<PluginBundleRepository['cancelInstall']>(() =>
      Promise.resolve({ status: 'cancelled' as const }),
    ),
    removeBundle: vi.fn<PluginBundleRepository['removeBundle']>(() =>
      Promise.resolve({
        name: bundle.name,
        changed: true,
        application: 'applied' as const,
        stage: 'remove' as const,
      }),
    ),
    setPluginEnabled: vi.fn<PluginBundleRepository['setPluginEnabled']>((name, enabled) =>
      Promise.resolve({
        name,
        changed: true,
        application: 'applied' as const,
        enabled,
        stage: 'enable' as const,
      }),
    ),
    setBundleEnabled: vi.fn<PluginBundleRepository['setBundleEnabled']>((name, enabled) =>
      Promise.resolve({
        name,
        changed: true,
        application: 'restart-required' as const,
        enabled,
        stage: 'enable' as const,
      }),
    ),
  }
  const repository: PluginBundleRepository = mocks
  const inventory = vi.fn(() =>
    Promise.resolve({ entries: [], managementAvailable: options.available ?? true }),
  )
  const backend = {
    plugins: { inventory },
    ...(options.hasRepository === false ? {} : { pluginBundles: repository }),
  } as unknown as DshBackend
  return { useCases: new PluginBundleUseCases(backend), inventory, mocks }
}

describe('PluginBundleUseCases', () => {
  it('keeps official install sources private and resolves the current target with an exact version', async () => {
    const services = useCases()
    const official: PluginManagerBundle = {
      ...bundle,
      official: true,
      availability: 'missing',
      installTarget: { spec: '/fixture/development/official', version: '0.2.1-alpha.2' },
    }
    services.mocks.listBundles.mockResolvedValue([official])
    const catalog = await services.useCases.list()
    expect(catalog.bundles[0]).toMatchObject({ installable: true, targetVersion: '0.2.1-alpha.2' })
    expect(catalog.bundles[0]).not.toHaveProperty('installTarget')
    const signal = new AbortController().signal
    const confirm = vi.fn(() => Promise.resolve(true))
    await services.useCases.install(
      bundle.name,
      'install-official',
      undefined,
      undefined,
      signal,
      confirm,
      undefined,
      undefined,
      true,
    )
    expect(services.mocks.inspect).toHaveBeenCalledWith(official.installTarget!.spec, undefined, signal)
    expect(services.mocks.installBundle).toHaveBeenCalledWith(
      official.installTarget!.spec,
      { requestId: 'install-official', saveExact: true },
      signal,
    )
    services.mocks.listBundles.mockResolvedValue([{ ...official, availability: 'profile' }])
    await expect(
      services.useCases.install(
        bundle.name,
        'stale-official',
        undefined,
        undefined,
        signal,
        confirm,
        undefined,
        undefined,
        true,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED' })
    expect(services.mocks.installBundle).toHaveBeenCalledTimes(1)
  })

  it('requires Host approval before install and leaves declined installs untouched', async () => {
    const services = useCases()
    const confirmInstall = vi.fn(() => Promise.resolve(false))
    await expect(
      services.useCases.install(
        '@dsh-community/review-layer',
        'install-1',
        null,
        undefined,
        new AbortController().signal,
        confirmInstall,
      ),
    ).resolves.toEqual({ name: bundle.name, changed: false, application: 'cancelled', stage: 'install' })
    expect(confirmInstall).toHaveBeenCalledWith('@dsh-community/review-layer', inspection)
    expect(services.mocks.installBundle).not.toHaveBeenCalled()

    await expect(
      services.useCases.install(
        '@dsh-community/review-layer',
        'install-2',
        null,
        undefined,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED', retryable: true })
  })

  it('requires a separate Host grant for package build scripts and then runs the approved package names', async () => {
    const services = useCases()
    const confirmInstall = vi.fn(() => Promise.resolve(true))
    const confirmBuilds = vi.fn(() => Promise.resolve(true))
    await services.useCases.install(
      '@dsh-community/review-layer',
      'install-3',
      null,
      ['native-addon'],
      new AbortController().signal,
      confirmInstall,
      confirmBuilds,
    )
    expect(confirmBuilds).toHaveBeenCalledWith(['native-addon'])
    expect(services.mocks.installBundle).toHaveBeenCalledWith(
      '@dsh-community/review-layer',
      { requestId: 'install-3', registry: null, approvedBuilds: ['native-addon'] },
      expect.any(AbortSignal),
    )
  })

  it('checks install inspection and blocks known non-bundles before approval', async () => {
    const services = useCases()
    services.mocks.inspect.mockResolvedValue({ ...inspection, bundle: false })
    await expect(
      services.useCases.install(
        '@dsh-community/plain-package',
        'install-4',
        null,
        undefined,
        new AbortController().signal,
        () => Promise.resolve(true),
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED', retryable: true })
    expect(services.mocks.installBundle).not.toHaveBeenCalled()
  })

  it('keeps errors from the install Remote indeterminate for RC2 recovery', async () => {
    const services = useCases()
    const disconnect = Object.assign(new Error('connection lost after request dispatch'), {
      code: 'BACKEND_UNREACHABLE',
    })
    services.mocks.installBundle.mockRejectedValue(disconnect)

    await expect(
      services.useCases.install(
        '@dsh-community/review-layer',
        'install-remote-error',
        null,
        undefined,
        new AbortController().signal,
        () => Promise.resolve(true),
      ),
    ).rejects.toBe(disconnect)
    expect(services.mocks.installBundle).toHaveBeenCalledOnce()
  })

  it('requires fresh catalog membership and host confirmation before enable or removal', async () => {
    const services = useCases()
    const confirmEnable = vi.fn(() => Promise.resolve(true))
    await expect(
      services.useCases.setEnabled(bundle.name, true, undefined, confirmEnable),
    ).resolves.toMatchObject({
      application: 'restart-required',
      enabled: true,
    })
    expect(confirmEnable).toHaveBeenCalledWith(bundle)
    expect(services.mocks.setBundleEnabled).toHaveBeenCalledWith(bundle.name, true, undefined)

    const confirmRemove = vi.fn(() => Promise.resolve(false))
    await expect(services.useCases.remove(bundle.name, undefined, confirmRemove)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('rejects read-only plugin rows and routes current addressable entries', async () => {
    const services = useCases()
    await expect(services.useCases.setPluginEnabled(plugin.entryId, false)).resolves.toMatchObject({
      enabled: false,
    })
    expect(services.mocks.setPluginEnabled).toHaveBeenCalledWith(plugin.entryId, false, undefined)

    services.mocks.listPlugins.mockResolvedValue([{ ...plugin, readOnlyReason: 'management-required' }])
    await expect(services.useCases.setPluginEnabled(plugin.entryId, false)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(services.mocks.setPluginEnabled).toHaveBeenCalledOnce()
  })

  it('requires Host approval before enabling a plugin entry and preserves decline without calling DSH', async () => {
    const services = useCases()
    const disabledPlugin = { ...plugin, enabled: false }
    services.mocks.listPlugins.mockResolvedValue([disabledPlugin])

    await expect(services.useCases.setPluginEnabled(plugin.entryId, true)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(services.mocks.setPluginEnabled).not.toHaveBeenCalled()

    const decline = vi.fn(() => Promise.resolve(false))
    await expect(
      services.useCases.setPluginEnabled(plugin.entryId, true, undefined, decline),
    ).resolves.toEqual({
      name: plugin.entryId,
      changed: false,
      application: 'cancelled',
      enabled: true,
      stage: 'enable',
    })
    expect(decline).toHaveBeenCalledWith(disabledPlugin)
    expect(services.mocks.setPluginEnabled).not.toHaveBeenCalled()

    const approve = vi.fn(() => Promise.resolve(true))
    await expect(
      services.useCases.setPluginEnabled(plugin.entryId, true, undefined, approve),
    ).resolves.toMatchObject({ enabled: true, application: 'applied' })
    expect(approve).toHaveBeenCalledWith(disabledPlugin)
    expect(services.mocks.setPluginEnabled).toHaveBeenCalledWith(plugin.entryId, true, undefined)
  })
})
