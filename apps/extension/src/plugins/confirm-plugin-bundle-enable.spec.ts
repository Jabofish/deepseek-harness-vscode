import { describe, expect, it, vi } from 'vitest'
import { createPluginBundleEnableConfirmation } from './confirm-plugin-bundle-enable.js'

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
