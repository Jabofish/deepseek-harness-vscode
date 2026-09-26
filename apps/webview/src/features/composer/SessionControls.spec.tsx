// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration, ModelDescriptor } from '@dsh-vscode/domain'
import { I18nProvider } from '../../i18n.js'
import { formatPresetLabel, modeIcon, permissionOptions, SessionControls } from './SessionControls.js'

const REASONER: readonly ModelDescriptor[] = [
  {
    id: 'deepseek-reasoner',
    providerId: 'deepseek',
    label: 'DeepSeek Reasoner',
    supportsReasoning: true,
    reasoningLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
  },
]

/** The session's own configuration; model ids are empty until someone chooses. */
function configuration(model: AgentConfiguration['model']): AgentConfiguration {
  return {
    preset: 'standard',
    toolMode: 'native',
    permissionPreset: 'workspace-write',
    planMode: false,
    model,
  }
}

function renderSeat(
  props: Partial<Pick<Parameters<typeof SessionControls>[0], 'modelCurrent' | 'models'>> & {
    readonly model: AgentConfiguration['model']
  },
): void {
  render(
    <I18nProvider>
      <SessionControls
        configuration={configuration(props.model)}
        models={props.models ?? REASONER}
        presets={[{ id: 'standard', trust: 'system', isDefault: true }]}
        permissionPresets={['workspace-write']}
        disabled={false}
        presetMutable
        {...(props.modelCurrent === undefined ? {} : { modelCurrent: props.modelCurrent })}
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />
    </I18nProvider>,
  )
}

function modelTriggerLabel(): string {
  const trigger = screen.getByRole('button', { name: /^Model and reasoning: /u })
  return trigger.querySelector('.dsh-select-menu__trigger-text')?.textContent ?? ''
}

describe('SessionControls model seat', () => {
  afterEach(() => cleanup())

  it('states the route the host named while the session names none', () => {
    // The configuration carries a selection only once someone makes one; an
    // empty one is not "no model", it is whatever the host routes by default.
    // Reporting a generic "Default model" would hide the route the host named.
    renderSeat({
      model: { providerId: '', modelId: '' },
      modelCurrent: { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'low' },
    })

    expect(modelTriggerLabel()).toBe('DeepSeek Reasoner · Low')
  })

  it('still says the default when no directory named a route', () => {
    renderSeat({ model: { providerId: '', modelId: '' } })

    expect(modelTriggerLabel()).toBe('Default model')
  })

  it("keeps the session's own choice over the route the host named", () => {
    renderSeat({
      model: { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'high' },
      modelCurrent: { providerId: 'anthropic', modelId: 'claude-sonnet' },
    })

    expect(modelTriggerLabel()).toBe('DeepSeek Reasoner · High')
  })

  it("keeps the host's route out of the configuration when another control changes", () => {
    // The fallback is a statement about routing, not a choice the session made:
    // a control that sends the configuration back must not carry it, or the
    // next write would persist a model the user never picked.
    const onChange = vi.fn()
    render(
      <I18nProvider>
        <SessionControls
          configuration={configuration({ providerId: '', modelId: '' })}
          models={REASONER}
          modelCurrent={{ providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'low' }}
          presets={[
            { id: 'standard', trust: 'system', isDefault: true },
            { id: 'gateway-lab', name: 'Gateway Lab', trust: 'user', isDefault: false },
          ]}
          permissionPresets={['workspace-write']}
          disabled={false}
          presetMutable
          onChange={onChange}
          onCommand={vi.fn()}
        />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Mode: Standard' }))
    fireEvent.click(screen.getByRole('option', { name: 'Gateway Lab' }))

    expect(onChange).toHaveBeenCalledWith({
      ...configuration({ providerId: '', modelId: '' }),
      preset: 'gateway-lab',
    })
  })
})

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
    expect(screen.getByLabelText('Context ~2.2k / 128.0k tokens').closest('dd')?.className).toContain(
      'dsh-session-controls__context-cell',
    )
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

  it('disables optional permission and plan controls when DSH does not advertise their commands', () => {
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
        commands={[{ name: 'model', description: 'Select the model' }]}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
      />,
    )

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Access: Workspace Write' }).disabled).toBe(
      true,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on plan mode' }).disabled).toBe(true)
    expect(screen.getByTitle('Plan mode is unavailable in this DSH session')).toBeDefined()
  })

  it('offers bounded workflow profiles and accepts Plan only when DSH advertises it', () => {
    const onPromptModeChange = vi.fn()
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
        permissionPresets={['workspace-write']}
        commands={[{ name: 'plan', description: 'Toggle plan mode' }]}
        promptMode="ask"
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
        onPromptModeChange={onPromptModeChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Workflow: Ask' }))
    expect(screen.getByRole('option', { name: 'Ask' })).toBeDefined()
    expect(screen.getByRole('option', { name: 'Debug' })).toBeDefined()
    fireEvent.click(screen.getByRole('option', { name: 'Plan' }))
    expect(onPromptModeChange).toHaveBeenCalledWith('plan')
  })

  it('disables the workflow Plan profile when the command is not advertised', () => {
    const onPromptModeChange = vi.fn()
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
        permissionPresets={['workspace-write']}
        commands={[{ name: 'model', description: 'Select the model' }]}
        promptMode="ask"
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={vi.fn()}
        onPromptModeChange={onPromptModeChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Workflow: Ask' }))
    expect(screen.getByRole<HTMLButtonElement>('option', { name: 'Plan' }).disabled).toBe(true)
    expect(onPromptModeChange).not.toHaveBeenCalled()
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
    expect(formatPresetLabel('standard', undefined)).toBe('presets.builtin.standard.name')
    expect(formatPresetLabel('ptc', undefined)).toBe('presets.builtin.ptc.name')
    expect(formatPresetLabel('minimal', undefined)).toBe('presets.builtin.minimal.name')
    expect(formatPresetLabel('cordis', undefined)).toBe('presets.builtin.cordis.name')
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
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    expect(onCommand).not.toHaveBeenCalled()
    const enable = screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Full access' })
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(enable)
    expect(onCommand).toHaveBeenCalledWith('/permission danger-full-access')
  })

  it('dismisses the full-access prompt on Escape without touching the permission', () => {
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
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole('alertdialog', { name: 'Enable Full access?' })).toBeDefined()

    // Backing out of the prompt must be as cheap as cancelling it: the
    // acknowledgement is scoped to the pending preset and never reaches DSH.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('dismisses the full-access prompt on outside pointer input', () => {
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
    fireEvent.click(screen.getByRole('option', { name: 'Full Access' }))
    expect(screen.getByRole('alertdialog', { name: 'Enable Full access?' })).toBeDefined()

    const prompt = screen.getByRole('alertdialog', { name: 'Enable Full access?' })
    fireEvent.pointerDown(prompt)
    expect(screen.queryByRole('alertdialog')).not.toBeNull()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onCommand).not.toHaveBeenCalled()
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

    expect(screen.getByRole('button', { name: 'Access: Full Access' }).parentElement?.className).toContain(
      'dsh-session-controls__access-picker--full-access',
    )
  })
})

it('requires explicit acknowledgement before selecting experimental Auto permissions', () => {
  const onCommand = vi.fn()
  render(
    <I18nProvider>
      <SessionControls
        configuration={configuration({ providerId: '', modelId: '' })}
        models={[]}
        presets={[]}
        permissionPresets={['workspace-write', 'auto']}
        disabled={false}
        presetMutable
        onChange={vi.fn()}
        onCommand={onCommand}
      />
    </I18nProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Access: Workspace Write' }))
  fireEvent.click(screen.getByRole('option', { name: 'Auto · EXP' }))
  expect(onCommand).not.toHaveBeenCalled()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Auto' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Enable Auto' }))
  expect(onCommand).toHaveBeenCalledExactlyOnceWith('/permission auto')
  cleanup()
})

describe('permission catalog lifecycle', () => {
  afterEach(() => cleanup())

  it('keeps a withdrawn current Auto permission visible but prevents selecting it again', () => {
    const onCommand = vi.fn()
    const seat = {
      configuration: { ...configuration({ providerId: '', modelId: '' }), permissionPreset: 'auto' },
      models: [],
      presets: [],
      disabled: false,
      presetMutable: true,
      onChange: vi.fn(),
      onCommand,
    } as const
    const { rerender } = render(
      <I18nProvider>
        <SessionControls {...seat} permissionPresets={['workspace-write', 'auto']} />
      </I18nProvider>,
    )

    // Auto is removed by the upstream integration while it is this Session's
    // durable current value. The label is retained, but the roster is authoritative.
    rerender(
      <I18nProvider>
        <SessionControls {...seat} permissionPresets={['workspace-write']} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Access: Auto · EXP' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Access: Auto · EXP' }))
    const withdrawnAuto = screen.getByRole<HTMLButtonElement>('option', { name: 'Auto · EXP' })
    expect(withdrawnAuto.disabled).toBe(true)
    fireEvent.click(withdrawnAuto)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onCommand).not.toHaveBeenCalled()
    cleanup()
  })

  it('cancels Auto risk acknowledgement when the catalog withdraws and restores Auto', () => {
    const onCommand = vi.fn()
    const seat = {
      configuration: configuration({ providerId: '', modelId: '' }),
      models: [],
      presets: [],
      disabled: false,
      presetMutable: true,
      onChange: vi.fn(),
      onCommand,
    } as const
    const { rerender } = render(
      <I18nProvider>
        <SessionControls {...seat} permissionPresets={['workspace-write', 'auto']} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Access: Workspace Write' }))
    fireEvent.click(screen.getByRole('option', { name: 'Auto · EXP' }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Auto' }).disabled).toBe(false)

    rerender(
      <I18nProvider>
        <SessionControls {...seat} permissionPresets={['workspace-write']} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()
    rerender(
      <I18nProvider>
        <SessionControls {...seat} permissionPresets={['workspace-write', 'auto']} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('alertdialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Access: Workspace Write' }))
    fireEvent.click(screen.getByRole('option', { name: 'Auto · EXP' }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Auto' }).disabled).toBe(true)
    expect(onCommand).not.toHaveBeenCalled()
    cleanup()
  })
})
