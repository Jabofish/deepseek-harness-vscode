import { describe, expect, it, vi } from 'vitest'
import type { PluginBundleUseCases } from '@dsh-vscode/application'
import { handlePluginBundleFeatureRequest } from './plugin-bundle-feature-handler.js'

describe('optional bundle feature route', () => {
  it('returns the live catalog and availability as a strict feature payload', async () => {
    const list = vi.fn(() =>
      Promise.resolve({
        available: true,
        bundles: [{ name: '@dsh-community/review', enabled: false, installed: false, hasIssue: false }],
      }),
    )
    const bundles = {
      list,
    } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal

    await expect(
      handlePluginBundleFeatureRequest({ type: 'plugin.bundles.list', payload: {} }, bundles, signal),
    ).resolves.toEqual({
      kind: 'plugin.bundles',
      available: true,
      bundles: [{ name: '@dsh-community/review', enabled: false, installed: false, hasIssue: false }],
    })
    expect(list).toHaveBeenCalledWith(signal)
  })

  it('routes only the selected dynamic name and boolean to the use case', async () => {
    const setEnabled = vi.fn((name: string, enabled: boolean) =>
      Promise.resolve({
        name,
        changed: true,
        application: 'restart-required' as const,
        enabled,
      }),
    )
    const bundles = {
      setEnabled,
    } as unknown as PluginBundleUseCases
    const signal = new AbortController().signal
    const confirmEnable = vi.fn(() => Promise.resolve(true))

    await expect(
      handlePluginBundleFeatureRequest(
        {
          type: 'plugin.bundle.setEnabled',
          payload: { name: '@dsh-community/review', enabled: true },
        },
        bundles,
        signal,
        confirmEnable,
      ),
    ).resolves.toEqual({
      kind: 'plugin.bundle.changed',
      result: {
        name: '@dsh-community/review',
        changed: true,
        application: 'restart-required',
        enabled: true,
      },
    })
    expect(setEnabled).toHaveBeenCalledWith('@dsh-community/review', true, signal, confirmEnable)
  })
})
