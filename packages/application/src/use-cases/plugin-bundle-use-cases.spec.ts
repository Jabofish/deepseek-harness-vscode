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
  it('returns all live bundle and plugin records only when the Host reports manager availability', async () => {
    const services = useCases()
    await expect(services.useCases.list()).resolves.toEqual({
      available: true,
      bundles: [bundle],
      plugins: [plugin],
    })
    expect(services.mocks.listBundles).toHaveBeenCalledOnce()
    expect(services.mocks.listPlugins).toHaveBeenCalledOnce()

    const unavailable = useCases({ available: false })
    await expect(unavailable.useCases.list()).resolves.toEqual({ available: false, bundles: [], plugins: [] })
    expect(unavailable.mocks.listBundles).not.toHaveBeenCalled()

    const unsupported = useCases({ hasRepository: false })
    await expect(unsupported.useCases.list()).resolves.toEqual({ available: false, bundles: [], plugins: [] })
    expect(unsupported.inventory).not.toHaveBeenCalled()
  })

  it('reads dynamically configured registries and inspects the selected package source', async () => {
    const services = useCases()
    await expect(services.useCases.registries()).resolves.toEqual({
      registry: null,
      fallbackRegistries: [],
      resolved: 'https://registry.npmjs.org/',
    })
    await expect(services.useCases.inspect('@dsh-community/review-layer', null)).resolves.toEqual(inspection)
    expect(services.mocks.inspect).toHaveBeenCalledWith('@dsh-community/review-layer', null, undefined)
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
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
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
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
    expect(services.mocks.installBundle).not.toHaveBeenCalled()
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

  it('handles removals only for removable bundles and honors explicit cancellation', async () => {
    const services = useCases()
    const removable = { ...bundle, installed: true, optional: false, removable: true }
    services.mocks.listBundles.mockResolvedValue([removable])
    await expect(
      services.useCases.remove(removable.name, undefined, () => Promise.resolve(false)),
    ).resolves.toEqual({
      name: removable.name,
      changed: false,
      application: 'cancelled',
      stage: 'remove',
    })
    expect(services.mocks.removeBundle).not.toHaveBeenCalled()
    await services.useCases.remove(removable.name, undefined, () => Promise.resolve(true))
    expect(services.mocks.removeBundle).toHaveBeenCalledWith(removable.name, undefined)
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

  it('aborts a DSH install through the request-scoped cancellation Remote', async () => {
    const services = useCases()
    let finishInstall!: (value: Awaited<ReturnType<PluginBundleRepository['installBundle']>>) => void
    services.mocks.installBundle.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve
      }),
    )
    const controller = new AbortController()
    const pending = services.useCases.install(
      '@dsh-community/review-layer',
      'install-5',
      null,
      undefined,
      controller.signal,
      () => Promise.resolve(true),
    )
    await vi.waitFor(() => expect(services.mocks.installBundle).toHaveBeenCalledOnce())
    controller.abort()
    await vi.waitFor(() => expect(services.mocks.cancelInstall).toHaveBeenCalledWith('install-5'))
    finishInstall({ name: bundle.name, changed: false, application: 'cancelled', stage: 'install' })
    await expect(pending).resolves.toMatchObject({ application: 'cancelled' })
  })
})
