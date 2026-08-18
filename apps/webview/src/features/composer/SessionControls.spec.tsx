// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatPresetLabel, modeIcon, permissionOptions, SessionControls } from './SessionControls.js'

describe('SessionControls', () => {
  afterEach(() => cleanup())

  it('shows projected context occupancy against the route capacity', () => {
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'both',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        }}
        models={[
          {
            id: 'deepseek-v4-flash',
            providerId: 'deepseek',
            label: 'DeepSeek V4 Flash',
            supportsReasoning: true,
          },
        ]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write']}
        estimatedContextTokens={2_200}
        contextWindowTokens={128_000}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Context ~2.2k / 128.0k tokens')).toBeDefined()
    expect(screen.queryByLabelText(/Cache hit/u)).toBeNull()
  })

  it('does not invent a context total before DSH reports context pressure', () => {
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        }}
        models={[
          {
            id: 'deepseek-v4-flash',
            providerId: 'deepseek',
            label: 'DeepSeek V4 Flash',
            supportsReasoning: false,
            contextWindow: 128_000,
          },
        ]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write']}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText(/Context .* tokens/u)).toBeNull()
    expect(screen.queryByLabelText(/Cache hit/u)).toBeNull()
  })

  it('does not use model metadata as a substitute for DSH context capacity', () => {
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' },
        }}
        models={[
          {
            id: 'deepseek-v4-flash',
            providerId: 'deepseek',
            label: 'DeepSeek V4 Flash',
            supportsReasoning: false,
            contextWindow: 128_000,
          },
        ]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write']}
        estimatedContextTokens={2_200}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText(/Context .* tokens/u)).toBeNull()
  })

  it('does not fabricate permission presets when the projection is absent', () => {
    expect(permissionOptions('workspace-write', [])).toEqual(['workspace-write'])
  })

  it('uses distinct mode icons and localized built-in mode labels', () => {
    expect(modeIcon('standard', 'Standard')).toBe('session')
    expect(modeIcon('plan', 'Plan')).toBe('plan')
    expect(modeIcon('code', 'Code')).toBe('terminal')
    expect(modeIcon('deep-research', 'Deep Research')).toBe('search')
    expect(modeIcon('subagent', 'Subagent')).toBe('users')
    expect(
      formatPresetLabel('deep-research', 'Deep Research', (key) =>
        key === 'controls.mode.research' ? '研究' : key,
      ),
    ).toBe('研究')
  })

  it('requires acknowledgement before sending the exact full-access command', () => {
    const onCommand = vi.fn()
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        }}
        models={[]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write', 'danger-full-access']}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={onCommand}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Access: Workspace Write' }))
    fireEvent.click(screen.getByRole('option', { name: 'Full access' }))
    expect(onCommand).not.toHaveBeenCalled()
    const enable = screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Full access' })
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(enable)
    expect(onCommand).toHaveBeenCalledWith('/permission danger-full-access')
  })

  it('marks full access with the warning-colored access control', () => {
    render(
      <SessionControls
        configuration={{
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'danger-full-access',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        }}
        models={[]}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['danger-full-access']}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Access: Full access' }).parentElement?.className).toContain(
      'dsh-session-controls__access-picker--full-access',
    )
  })
})
