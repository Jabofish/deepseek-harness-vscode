import { describe, expect, it, vi } from 'vitest'
import {
  createPluginBundleEnableConfirmation,
  createPluginEntryEnableConfirmation,
} from './confirm-plugin-bundle-enable.js'

const bundle = {
  name: '@dsh-community/review-layer',
  title: { en: 'Review layer', zh: '审查层' },
  enabled: false,
  installed: false,
  optional: true,
  removable: false,
  rows: [],
  overrides: [],
} as const

describe('Host modal for optional bundle activation', () => {
  it('requires the explicit modal action and names the profile-wide Host-code effect', async () => {
    const present = vi.fn(() => Promise.resolve('Enable bundle'))
    const confirm = createPluginBundleEnableConfirmation(
      present,
      (message, title) => {
        return title === undefined ? message : message.replace('{0}', title)
      },
      'en',
    )

    await expect(confirm(bundle)).resolves.toBe(true)
    expect(present).toHaveBeenCalledWith(
      'Enable plugin bundle "Review layer" for the current DSH profile?',
      {
        modal: true,
        detail:
          'This affects every session using this profile. Enabling the bundle may run its code in the DSH Host process outside the workspace sandbox. Continue only if you trust it; a restart may be required.',
      },
      'Enable bundle',
    )
  })

  it('treats closing the modal as a decline', async () => {
    const present = vi.fn(() => Promise.resolve(undefined))
    const confirm = createPluginBundleEnableConfirmation(present, (message) => message, 'en')

    await expect(confirm(bundle)).resolves.toBe(false)
    expect(present).toHaveBeenCalledOnce()
  })
})

describe('Host modal for individual plugin entry activation', () => {
  const plugin = {
    entryId: 'review:extension',
    moduleName: '@dsh-community/review-layer/extension',
    meta: { title: { en: 'Review extension', zh: '审查扩展' } },
    enabled: false,
    fiberPhase: null,
  } as const

  it('names the plugin and explains profile-wide Host execution before enabling', async () => {
    const present = vi.fn(() => Promise.resolve('Enable plugin'))
    const confirm = createPluginEntryEnableConfirmation(
      present,
      (message, title) => (title === undefined ? message : message.replace('{0}', title)),
      'en',
    )

    await expect(confirm(plugin)).resolves.toBe(true)
    expect(present).toHaveBeenCalledWith(
      'Enable DSH plugin "Review extension" for the current profile?',
      {
        modal: true,
        detail:
          'This affects every session using this profile. If the profile is running, DSH may reload this plugin immediately and run its code in the DSH Host process outside the workspace sandbox. Continue only if you trust it.',
      },
      'Enable plugin',
    )
  })

  it('treats closing the modal as a decline', async () => {
    const present = vi.fn(() => Promise.resolve(undefined))
    const confirm = createPluginEntryEnableConfirmation(present, (message) => message, 'en')

    await expect(confirm(plugin)).resolves.toBe(false)
  })
})
