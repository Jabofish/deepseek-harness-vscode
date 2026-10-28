import { describe, expect, it, vi } from 'vitest'
import type { PluginBundleUseCases } from '@dsh-vscode/application'
import {
  handlePluginBundleFeatureRequest,
  PluginInstallRequestCoordinator,
} from './plugin-bundle-feature-handler.js'

describe('Plugin Manager feature route', () => {
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

  it.each([
    {
      label: 'a different spec',
      conflict: { spec: '@dsh-community/other-bundle' },
      first: {
        spec: '@dsh-community/review-layer',
        registry: 'https://registry.example.test/',
        approvedBuilds: ['native-addon', 'compiler'],
      },
    },
    {
      label: 'an explicit registry value instead of an omitted registry',
      conflict: { registry: null },
      first: {
        spec: '@dsh-community/review-layer',
        approvedBuilds: ['native-addon', 'compiler'],
      },
    },
    {
      label: 'a different approved build sequence',
      conflict: { approvedBuilds: ['compiler', 'native-addon'] },
      first: {
        spec: '@dsh-community/review-layer',
        approvedBuilds: ['native-addon', 'compiler'],
      },
    },
    {
      label: 'an explicit empty build approval list instead of an omitted list',
      conflict: { approvedBuilds: [] },
      first: { spec: '@dsh-community/review-layer' },
    },
  ] as const)(
    'rejects a reused active install id with $label without affecting the first install',
    async ({ conflict, first }) => {
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
      const installRequestId = 'install-conflicting-active-id'
      const firstRequest = {
        type: 'plugin.bundle.install' as const,
        payload: { ...first, installRequestId },
      }
      const conflictingRequest = {
        type: 'plugin.bundle.install' as const,
        payload: {
          ...first,
          ...conflict,
          installRequestId,
        },
      }

      const firstPromise = handlePluginBundleFeatureRequest(
        firstRequest,
        bundles,
        signal,
        undefined,
        coordinator,
      )
      await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
      await expect(
        handlePluginBundleFeatureRequest(conflictingRequest, bundles, signal, undefined, coordinator),
      ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED' })
      expect(install).toHaveBeenCalledOnce()

      finish({
        name: first.spec,
        changed: true,
        application: 'applied',
        stage: 'install',
      })
      await expect(firstPromise).resolves.toMatchObject({
        kind: 'plugin.bundle.changed',
        result: { name: first.spec, application: 'applied' },
      })
      expect(install).toHaveBeenCalledOnce()
    },
  )

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

  it('latches cancellation received before the install handler starts', async () => {
    const cancelInstall = vi.fn(() => Promise.resolve({ status: 'not-running' as const }))
    const install = vi.fn(
      (
        _spec: string,
        _requestId: string,
        _registry: unknown,
        _approvedBuilds: unknown,
        installSignal: AbortSignal,
      ) => {
        expect(installSignal.aborted).toBe(true)
        return Promise.reject(
          Object.assign(new Error('cancelled before install Remote'), {
            code: 'PLUGIN_INSTALL_NOT_STARTED',
          }),
        )
      },
    )
    const bundles = { cancelInstall, install } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const coordinator = new PluginInstallRequestCoordinator()
    const installRequestId = 'install-cancel-before-handler'
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
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED' })

    expect(cancelInstall).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledOnce()
  })
})
