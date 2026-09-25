import { describe, expect, it, vi } from 'vitest'
import type { PluginBundleUseCases } from '@dsh-vscode/application'
import {
  handlePluginBundleFeatureRequest,
  PluginInstallRequestCoordinator,
} from './plugin-bundle-feature-handler.js'

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

  it('forwards the Host confirmation callback for an individual plugin entry enable', async () => {
    const result = {
      name: 'review:extension',
      changed: true,
      application: 'restart-required',
      enabled: true,
      stage: 'enable',
    } as const
    const setPluginEnabled = vi.fn(() => Promise.resolve(result))
    const bundles = { setPluginEnabled } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const pluginEntryEnable = vi.fn(() => Promise.resolve(true))

    await expect(
      handlePluginBundleFeatureRequest(
        {
          type: 'plugin.entry.setEnabled',
          payload: { entryId: 'review:extension', enabled: true },
        },
        bundles,
        signal,
        { pluginEntryEnable },
      ),
    ).resolves.toEqual({ kind: 'plugin.bundle.changed', result })
    expect(setPluginEnabled).toHaveBeenCalledWith('review:extension', true, signal, pluginEntryEnable)
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

  it('prevents a repeated install request id from starting a second DSH install', async () => {
    let finish!: (value: unknown) => void
    const install = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const bundles = { install } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const request = {
      type: 'plugin.bundle.install' as const,
      payload: { spec: '@dsh-community/review-layer', installRequestId: 'install-once' },
    }

    const first = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    const duplicate = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    finish({ name: '@dsh-community/review-layer', changed: true, application: 'applied', stage: 'install' })

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      {
        kind: 'plugin.bundle.changed',
        result: {
          name: '@dsh-community/review-layer',
          changed: true,
          application: 'applied',
          stage: 'install',
        },
      },
      {
        kind: 'plugin.bundle.changed',
        result: {
          name: '@dsh-community/review-layer',
          changed: true,
          application: 'applied',
          stage: 'install',
        },
      },
    ])
    expect(install).toHaveBeenCalledOnce()
  })

  it('recovers an active result and coalesces duplicate waits without caching settled null', async () => {
    let finish!: (value: unknown) => void
    const waitForInstall = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const bundles = { waitForInstall } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const request = {
      type: 'plugin.bundle.waitForInstall' as const,
      payload: { installRequestId: 'install-active' },
    }

    const first = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    const duplicate = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    await vi.waitFor(() => expect(waitForInstall).toHaveBeenCalledOnce())
    finish(null)
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { kind: 'plugin.install.waited', result: null },
      { kind: 'plugin.install.waited', result: null },
    ])
    expect(waitForInstall).toHaveBeenCalledWith('install-active', signal)

    waitForInstall.mockImplementationOnce(() => Promise.resolve(null))
    await expect(
      handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator),
    ).resolves.toEqual({ kind: 'plugin.install.waited', result: null })
    expect(waitForInstall).toHaveBeenCalledTimes(2)
  })

  it('projects a completed Host install result into wait recovery without calling RC2 again', async () => {
    const result = {
      name: '@dsh-community/review-layer',
      changed: true,
      application: 'applied',
      stage: 'install',
    } as const
    const install = vi.fn(() => Promise.resolve(result))
    const waitForInstall = vi.fn(() => Promise.resolve(null))
    const bundles = { install, waitForInstall } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const installRequestId = 'install-completed-host-result'

    await expect(
      handlePluginBundleFeatureRequest(
        {
          type: 'plugin.bundle.install',
          payload: { spec: result.name, installRequestId },
        },
        bundles,
        signal,
        undefined,
        coordinator,
      ),
    ).resolves.toEqual({ kind: 'plugin.bundle.changed', result })
    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.bundle.waitForInstall', payload: { installRequestId } },
        bundles,
        signal,
        undefined,
        coordinator,
      ),
    ).resolves.toEqual({ kind: 'plugin.install.waited', result })

    expect(install).toHaveBeenCalledOnce()
    expect(waitForInstall).not.toHaveBeenCalled()
  })

  it('does not wait for an in-flight Host install before falling back to the RC2 wait Remote', async () => {
    let finishInstall!: (value: unknown) => void
    const install = vi.fn(
      () =>
        new Promise((resolve) => {
          finishInstall = resolve
        }),
    )
    const waitForInstall = vi.fn(() => Promise.resolve(null))
    const bundles = { install, waitForInstall } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const installRequestId = 'install-still-running'
    const installRequest = handlePluginBundleFeatureRequest(
      {
        type: 'plugin.bundle.install',
        payload: { spec: '@dsh-community/review-layer', installRequestId },
      },
      bundles,
      signal,
      undefined,
      coordinator,
    )
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())

    await expect(
      handlePluginBundleFeatureRequest(
        { type: 'plugin.bundle.waitForInstall', payload: { installRequestId } },
        bundles,
        signal,
        undefined,
        coordinator,
      ),
    ).resolves.toEqual({ kind: 'plugin.install.waited', result: null })
    expect(waitForInstall).toHaveBeenCalledOnce()

    finishInstall({
      name: '@dsh-community/review-layer',
      changed: true,
      application: 'applied',
      stage: 'install',
    })
    await installRequest
  })

  it.each(['cache-miss', 'install-rejected', 'malformed-install'] as const)(
    'uses the RC2 wait Remote for %s Host cache state',
    async (cacheState) => {
      const install = vi.fn((): Promise<unknown> => {
        if (cacheState === 'install-rejected') return Promise.reject(new Error('install failed'))
        if (cacheState === 'malformed-install')
          return Promise.resolve({
            kind: 'plugin.bundle.changed',
            result: { name: 'bad', changed: true, application: 'applied', stage: 'other' },
          })
        return Promise.resolve({
          kind: 'plugin.bundle.changed',
          result: {
            name: '@dsh-community/review-layer',
            changed: true,
            application: 'applied',
            stage: 'install',
          },
        })
      })
      const waitForInstall = vi.fn(() => Promise.resolve(null))
      const bundles = { install, waitForInstall } as unknown as PluginBundleUseCases
      const signal = new AbortController().signal
      const coordinator = new PluginInstallRequestCoordinator()
      const installRequestId = `install-fallback-${cacheState}`

      if (cacheState !== 'cache-miss') {
        const installRequest = handlePluginBundleFeatureRequest(
          {
            type: 'plugin.bundle.install',
            payload: { spec: '@dsh-community/review-layer', installRequestId },
          },
          bundles,
          signal,
          undefined,
          coordinator,
        )
        if (cacheState === 'install-rejected') await expect(installRequest).rejects.toThrow('install failed')
        else await installRequest
      }

      await expect(
        handlePluginBundleFeatureRequest(
          { type: 'plugin.bundle.waitForInstall', payload: { installRequestId } },
          bundles,
          signal,
          undefined,
          coordinator,
        ),
      ).resolves.toEqual({ kind: 'plugin.install.waited', result: null })
      expect(waitForInstall).toHaveBeenCalledOnce()
    },
  )

  it('coalesces repeated cancellation for one install request id', async () => {
    let finish!: (value: unknown) => void
    const cancelInstall = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const bundles = { cancelInstall } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const request = {
      type: 'plugin.bundle.cancelInstall' as const,
      payload: { installRequestId: 'install-cancel-once' },
    }

    const first = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    const duplicate = handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator)
    await vi.waitFor(() => expect(cancelInstall).toHaveBeenCalledOnce())
    finish({ status: 'too-late' })

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { kind: 'plugin.install.cancelled', status: 'too-late' },
      { kind: 'plugin.install.cancelled', status: 'too-late' },
    ])
    expect(cancelInstall).toHaveBeenCalledOnce()
  })

  it.each(['cancelled', 'too-late'] as const)(
    'retries a settled not-running cancellation after DSH registers the same request (%s)',
    async (secondStatus) => {
      const cancelInstall = vi
        .fn()
        .mockResolvedValueOnce({ status: 'not-running' as const })
        .mockResolvedValueOnce({ status: secondStatus })
      const install = vi.fn(() =>
        Promise.resolve({
          name: '@dsh-community/review-layer',
          changed: true,
          application: 'applied' as const,
          stage: 'install' as const,
        }),
      )
      const bundles = { cancelInstall, install } as unknown as PluginBundleUseCases
      const signal = new AbortController().signal
      const coordinator = new PluginInstallRequestCoordinator()
      const installRequestId = `install-retry-${secondStatus}`
      const cancelRequest = {
        type: 'plugin.bundle.cancelInstall' as const,
        payload: { installRequestId },
      }

      await expect(
        handlePluginBundleFeatureRequest(cancelRequest, bundles, signal, undefined, coordinator),
      ).resolves.toEqual({ kind: 'plugin.install.cancelled', status: 'not-running' })
      await expect(
        handlePluginBundleFeatureRequest(
          {
            type: 'plugin.bundle.install',
            payload: { spec: '@dsh-community/review-layer', installRequestId },
          },
          bundles,
          signal,
          undefined,
          coordinator,
        ),
      ).resolves.toMatchObject({ kind: 'plugin.bundle.changed' })
      await expect(
        handlePluginBundleFeatureRequest(cancelRequest, bundles, signal, undefined, coordinator),
      ).resolves.toEqual({ kind: 'plugin.install.cancelled', status: secondStatus })
      await expect(
        handlePluginBundleFeatureRequest(cancelRequest, bundles, signal, undefined, coordinator),
      ).resolves.toEqual({ kind: 'plugin.install.cancelled', status: secondStatus })

      expect(install).toHaveBeenCalledOnce()
      expect(cancelInstall).toHaveBeenCalledTimes(2)
      expect(cancelInstall).toHaveBeenNthCalledWith(1, installRequestId, signal)
      expect(cancelInstall).toHaveBeenNthCalledWith(2, installRequestId, signal)
    },
  )

  it('retries cancellation after a Remote error instead of retaining a rejected result', async () => {
    const cancelInstall = vi
      .fn()
      .mockRejectedValueOnce(new Error('transport failed'))
      .mockResolvedValueOnce({ status: 'not-running' as const })
    const bundles = { cancelInstall } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const request = {
      type: 'plugin.bundle.cancelInstall' as const,
      payload: { installRequestId: 'install-cancel-error-retry' },
    }

    await expect(
      handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator),
    ).rejects.toThrow('transport failed')
    await expect(
      handlePluginBundleFeatureRequest(request, bundles, signal, undefined, coordinator),
    ).resolves.toEqual({ kind: 'plugin.install.cancelled', status: 'not-running' })
    expect(cancelInstall).toHaveBeenCalledTimes(2)
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
    expect(setPluginEnabled).toHaveBeenCalledWith('review:entry', false, signal, undefined)
    expect(setEnabled).toHaveBeenCalledWith('@dsh-community/review', true, signal, confirmations.enable)
  })
})
