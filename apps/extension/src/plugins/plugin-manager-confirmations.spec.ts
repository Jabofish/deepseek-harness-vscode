import { describe, expect, it, vi } from 'vitest'
import type { PluginSpecInspection } from '@dsh-vscode/domain'
import {
  createPluginBuildApprovalConfirmation,
  createPluginInstallConfirmation,
  createPluginRemoveConfirmation,
} from './plugin-manager-confirmations.js'

const translate = (message: string, value?: string): string =>
  value === undefined ? message : message.replace('{0}', value)

describe('Host confirmations for the RC2 Plugin Manager', () => {
  it('confirms an inspected package by its safe name without displaying private source specs', async () => {
    const present = vi.fn(() => Promise.resolve('Install plugin'))
    const confirm = createPluginInstallConfirmation(present, translate)
    const inspection: PluginSpecInspection = {
      status: 'accepted',
      kind: 'git',
      name: '@dsh-community/review',
      bundle: true,
      registry: null,
    }

    await expect(confirm('https://user:token@git.example.test/private/repo.git', inspection)).resolves.toBe(
      true,
    )
    expect(present).toHaveBeenCalledWith(
      'Install DSH plugin "@dsh-community/review"?',
      expect.objectContaining({ modal: true }),
      'Install plugin',
    )
    expect(JSON.stringify(present.mock.calls)).not.toContain('private')
    await expect(confirm('private-path', { status: 'refused', problem: 'not-a-bundle' })).resolves.toBe(false)
    expect(present).toHaveBeenCalledOnce()
  })

  it('requires an explicit Host choice to remove a profile bundle or run dependency scripts', async () => {
    const present = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('Allow and retry')
    const confirmRemove = createPluginRemoveConfirmation(present, translate)
    const confirmBuilds = createPluginBuildApprovalConfirmation(present, translate)
    const bundle = {
      name: '@dsh-community/review',
      enabled: true,
      installed: true,
      optional: false,
      removable: true,
      rows: [],
      overrides: [],
    }

    await expect(confirmRemove(bundle)).resolves.toBe(false)
    await expect(confirmBuilds(['native-addon'])).resolves.toBe(true)
    expect(present).toHaveBeenNthCalledWith(
      1,
      'Remove DSH plugin "@dsh-community/review" from this profile?',
      expect.objectContaining({ modal: true }),
      'Remove plugin',
    )
    expect(present).toHaveBeenNthCalledWith(
      2,
      'Allow install scripts for native-addon?',
      expect.objectContaining({ modal: true }),
      'Allow and retry',
    )
  })
})
