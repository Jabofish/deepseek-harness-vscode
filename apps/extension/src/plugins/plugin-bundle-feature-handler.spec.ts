import { describe, expect, it, vi } from 'vitest'
import type { PluginBundleUseCases } from '@dsh-vscode/application'
import { handlePluginBundleFeatureRequest } from './plugin-bundle-feature-handler.js'

describe('Plugin Manager feature route', () => {
  it('returns the live bundle and plugin inventory with availability', async () => {
    const snapshot = {
      available: true,
      bundles: [
        {
          name: '@dsh-community/review',
          enabled: false,
          installed: false,
          optional: true,
          removable: false,
          rows: [],
          overrides: [],
        },
      ],
      plugins: [
        { entryId: 'review:entry', moduleName: '@dsh-community/review', enabled: false, fiberPhase: null },
      ],
    }
    const list = vi.fn(() => Promise.resolve(snapshot))
    const bundles = { list } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal

    await expect(
      handlePluginBundleFeatureRequest({ type: 'plugin.bundles.list', payload: {} }, bundles, signal),
    ).resolves.toEqual({ kind: 'plugin.bundles', ...snapshot })
    expect(list).toHaveBeenCalledWith(signal)
  })

  it('routes configured registry inventory and package inspection', async () => {
    const catalog = { registry: 'https://registry.example.test/', fallbackRegistries: [], resolved: null }
    const inspection = { status: 'refused', problem: 'not-a-bundle' } as const
    const registries = vi.fn(() => Promise.resolve(catalog))
    const inspect = vi.fn(() => Promise.resolve(inspection))
    const bundles = { registries, inspect } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal

    await expect(
      handlePluginBundleFeatureRequest({ type: 'plugin.registries.list', payload: {} }, bundles, signal),
    ).resolves.toEqual({ kind: 'plugin.registries', available: true, registries: catalog })
    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.spec.inspect', payload: { spec: '@dsh-community/not-a-bundle', registry: null } },
        bundles,
        signal,
      ),
    ).resolves.toEqual({ kind: 'plugin.inspection', inspection })
    expect(registries).toHaveBeenCalledWith(signal)
    expect(inspect).toHaveBeenCalledWith('@dsh-community/not-a-bundle', null, signal)
  })

  it('passes installation consent and build approval through Host-owned callbacks', async () => {
    const result = {
      name: '@dsh-community/review',
      changed: true,
      application: 'applied',
      stage: 'install',
    } as const
    const install = vi.fn(() => Promise.resolve(result))
    const bundles = { install } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const confirmations = {
      install: vi.fn(() => Promise.resolve(true)),
      builds: vi.fn(() => Promise.resolve(true)),
    }

    await expect(
      handlePluginBundleFeatureRequest(
        {
          type: 'plugin.bundle.install',
          payload: {
            spec: '@dsh-community/review',
            installRequestId: 'install-request-1',
            registry: 'https://registry.example.test/',
            approvedBuilds: ['native-addon'],
          },
        },
        bundles,
        signal,
        confirmations,
      ),
    ).resolves.toEqual({ kind: 'plugin.bundle.changed', result })
    expect(install).toHaveBeenCalledWith(
      '@dsh-community/review',
      'install-request-1',
      'https://registry.example.test/',
      ['native-addon'],
      signal,
      confirmations.install,
      confirmations.builds,
    )
  })

  it('routes cancellation, bundle removal, per-entry enablement, and confirmed bundle enablement', async () => {
    const cancelInstall = vi.fn(() => Promise.resolve({ status: 'too-late' as const }))
    const removedResult = {
      name: '@dsh-community/review',
      changed: true,
      application: 'applied',
      stage: 'remove',
    } as const
    const remove = vi.fn(() => Promise.resolve(removedResult))
    const setPluginEnabled = vi.fn(() =>
      Promise.resolve({
        name: 'review:entry',
        changed: true,
        application: 'applied' as const,
        enabled: false,
        stage: 'enable' as const,
      }),
    )
    const setEnabled = vi.fn(() =>
      Promise.resolve({
        name: '@dsh-community/review',
        changed: true,
        application: 'restart-required' as const,
        enabled: true,
        stage: 'enable' as const,
      }),
    )
    const bundles = { cancelInstall, remove, setPluginEnabled, setEnabled } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const confirmations = {
      enable: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(true)),
    }

    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.bundle.cancelInstall', payload: { installRequestId: 'install-request-2' } },
        bundles,
        signal,
      ),
    ).resolves.toEqual({ kind: 'plugin.install.cancelled', status: 'too-late' })
    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.bundle.remove', payload: { name: '@dsh-community/review' } },
        bundles,
        signal,
        confirmations,
      ),
    ).resolves.toEqual({ kind: 'plugin.bundle.changed', result: removedResult })
    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.entry.setEnabled', payload: { entryId: 'review:entry', enabled: false } },
        bundles,
        signal,
      ),
    ).resolves.toMatchObject({
      kind: 'plugin.bundle.changed',
      result: { name: 'review:entry', enabled: false },
    })
    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.bundle.setEnabled', payload: { name: '@dsh-community/review', enabled: true } },
        bundles,
        signal,
        confirmations,
      ),
    ).resolves.toMatchObject({
      kind: 'plugin.bundle.changed',
      result: { enabled: true, application: 'restart-required' },
    })
    expect(cancelInstall).toHaveBeenCalledWith('install-request-2', signal)
    expect(remove).toHaveBeenCalledWith('@dsh-community/review', signal, confirmations.remove)
    expect(setPluginEnabled).toHaveBeenCalledWith('review:entry', false, signal)
    expect(setEnabled).toHaveBeenCalledWith('@dsh-community/review', true, signal, confirmations.enable)
  })
})
