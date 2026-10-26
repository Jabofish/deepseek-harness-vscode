// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfiguration, ModelDescriptor } from '@dsh-vscode/domain'
import { I18nProvider } from '../../i18n.js'
import { SessionControls } from './SessionControls.js'

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

  it("keeps the session's own choice over the route the host named", () => {
    renderSeat({
      model: { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'high' },
      modelCurrent: { providerId: 'anthropic', modelId: 'claude-sonnet' },
    })

    expect(modelTriggerLabel()).toBe('DeepSeek Reasoner · High')
  })
})

describe('SessionControls', () => {
  afterEach(() => cleanup())

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
