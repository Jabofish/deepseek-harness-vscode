import { describe, expect, it, vi } from 'vitest'
import type { DshBackend, OptionalPluginBundle, PluginBundleRepository } from '@dsh-vscode/domain'
import { PluginBundleUseCases } from './plugin-bundle-use-cases.js'

const offered: OptionalPluginBundle = {
  name: '@dsh-community/review-layer',
  enabled: false,
  installed: false,
  hasIssue: false,
}

function useCases(
  options: {
    readonly managementAvailable?: boolean
    readonly bundles?: readonly OptionalPluginBundle[]
    readonly hasRepository?: boolean
  } = {},
): {
  readonly useCases: PluginBundleUseCases
  readonly inventory: ReturnType<typeof vi.fn>
  readonly listOptionalBundles: ReturnType<typeof vi.fn>
  readonly setBundleEnabled: ReturnType<typeof vi.fn>
} {
  const inventory = vi.fn(() =>
    Promise.resolve({
      entries: [],
      managementAvailable: options.managementAvailable ?? true,
    }),
  )
  const listOptionalBundles = vi.fn(() => Promise.resolve(options.bundles ?? [offered]))
  const setBundleEnabled = vi.fn((name: string, enabled: boolean) =>
    Promise.resolve({
      name,
      changed: true,
      application: 'restart-required' as const,
      enabled,
    }),
  )
  const pluginBundles: PluginBundleRepository = { listOptionalBundles, setBundleEnabled }
  const backend = {
    plugins: { inventory },
    ...(options.hasRepository === false ? {} : { pluginBundles }),
  } as unknown as DshBackend
  return {
    useCases: new PluginBundleUseCases(backend),
    inventory,
    listOptionalBundles,
    setBundleEnabled,
  }
}

describe('PluginBundleUseCases', () => {
  it('returns optional bundle catalog only when the Host reports manager availability', async () => {
    const available = useCases()
    await expect(available.useCases.list()).resolves.toEqual({ available: true, bundles: [offered] })
    expect(available.inventory).toHaveBeenCalledOnce()
    expect(available.listOptionalBundles).toHaveBeenCalledOnce()

    const unavailable = useCases({ managementAvailable: false })
    await expect(unavailable.useCases.list()).resolves.toEqual({ available: false, bundles: [] })
    expect(unavailable.listOptionalBundles).not.toHaveBeenCalled()

    const unsupported = useCases({ hasRepository: false })
    await expect(unsupported.useCases.list()).resolves.toEqual({ available: false, bundles: [] })
    expect(unsupported.inventory).not.toHaveBeenCalled()
  })

  it('allows DSH-provided optional entries and validates names against the fresh dynamic catalog', async () => {
    const services = useCases({ bundles: [offered] })
    const confirmEnable = vi.fn(() => Promise.resolve(true))
    await expect(
      services.useCases.setEnabled(offered.name, true, undefined, confirmEnable),
    ).resolves.toMatchObject({
      application: 'restart-required',
      enabled: true,
    })
    expect(confirmEnable).toHaveBeenCalledWith(offered)
    expect(services.setBundleEnabled).toHaveBeenCalledWith(offered.name, true, undefined)

    await expect(
      services.useCases.setEnabled('@dsh-community/not-in-current-catalog', true),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(services.setBundleEnabled).toHaveBeenCalledOnce()
  })

  it('returns cancelled without an upstream mutation when the Host confirmation is declined', async () => {
    const services = useCases()
    await expect(
      services.useCases.setEnabled(offered.name, true, undefined, () => Promise.resolve(false)),
    ).resolves.toEqual({
      name: offered.name,
      changed: false,
      application: 'cancelled',
      enabled: true,
    })
    expect(services.setBundleEnabled).not.toHaveBeenCalled()

    await expect(services.useCases.setEnabled(offered.name, true)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    })
    expect(services.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('does not issue the mutation if the request is cancelled while the Host confirmation is open', async () => {
    const services = useCases()
    const controller = new AbortController()
    const confirmEnable = vi.fn(() => {
      controller.abort()
      return Promise.resolve(true)
    })
    await expect(
      services.useCases.setEnabled(offered.name, true, controller.signal, confirmEnable),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(services.setBundleEnabled).not.toHaveBeenCalled()
  })

  it('rejects profile mutations when Plugin Manager availability is absent and honors cancellation', async () => {
    const unavailable = useCases({ managementAvailable: false })
    await expect(unavailable.useCases.setEnabled(offered.name, false)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(unavailable.setBundleEnabled).not.toHaveBeenCalled()

    const cancelled = useCases()
    const controller = new AbortController()
    controller.abort()
    await expect(cancelled.useCases.list(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled.inventory).not.toHaveBeenCalled()
  })
})
