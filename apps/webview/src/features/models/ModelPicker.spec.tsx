// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ModelCatalogFailure, ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { ModelPicker } from './ModelPicker.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

afterEach(() => vi.useRealTimers())

const MODELS: readonly ModelDescriptor[] = [
  { id: 'deepseek-chat', providerId: 'deepseek', label: 'DeepSeek Chat', supportsReasoning: false },
  {
    id: 'deepseek-reasoner',
    providerId: 'deepseek',
    label: 'DeepSeek Reasoner',
    supportsReasoning: true,
    // No declared default: the adapter resolves the effort for this model, so
    // the seat may only say so rather than name one of the levels.
    reasoningLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
  },
  {
    id: 'claude-sonnet',
    providerId: 'anthropic',
    label: 'Claude Sonnet',
    supportsReasoning: true,
    reasoningLevels: [
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ],
    defaultReasoningLevel: 'high',
  },
]

const CHAT: ModelSelection = { providerId: 'deepseek', modelId: 'deepseek-chat' }
const REASONER: ModelSelection = {
  providerId: 'deepseek',
  modelId: 'deepseek-reasoner',
  reasoningLevel: 'low',
}

describe('DSH model selection behavior', () => {
  afterEach(() => cleanup())
  function focusedPicker(onChange = vi.fn()): ReturnType<typeof render> {
    return render(
      <ConversationLayoutProvider initialLayout="focused">
        <ModelPicker
          models={[
            ...MODELS,
            { id: 'swift-small', providerId: 'local', label: 'Swift Small', supportsReasoning: false },
            { id: 'swift-large', providerId: 'local', label: 'Swift Large', supportsReasoning: false },
          ]}
          value={REASONER}
          onChange={onChange}
          showIcon={false}
        />
      </ConversationLayoutProvider>,
    )
  }
  it('keeps search focused while arrows highlight and Enter chooses a filtered model', () => {
    const onChange = vi.fn()
    focusedPicker(onChange)
    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))
    const search = screen.getByRole('searchbox', { name: 'Search models' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: 'swl' } })
    expect(screen.getByRole('menuitemradio', { name: 'Swift Large' })).toBeDefined()
    fireEvent.change(search, { target: { value: 'swift' } })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(search)
    const highlighted = document.getElementById(search.getAttribute('aria-activedescendant')!)
    expect(highlighted?.textContent).toBe('Swift Large')
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith({ providerId: 'local', modelId: 'swift-large' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
})

describe('ModelPicker keyboard and focus contract', () => {
  afterEach(() => cleanup())

  it('keeps the picker open and announces a failed asynchronous model change', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('write failed'))
    renderPicker({ onChange })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))
    activate(screen.getByRole('menuitemradio', { name: /DeepSeek Reasoner/u }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not switch models. Check the connection and try again.')
    expect(screen.getByRole('menu')).toBeDefined()
    expect(trigger().getAttribute('aria-disabled')).toBe('false')
  })
})

describe('ModelPicker failure rows', () => {
  afterEach(() => cleanup())

  it('renders a failed provider with the host message whole and keeps the usable groups', () => {
    // The host does not bound this diagnostic and the reference client renders
    // it verbatim, so the picker is where a provider gets to explain itself.
    const message = `gateway rejected the credential: ${'the token expired at the last rotation; '.repeat(200)}`
    expect(message.length).toBeGreaterThan(4_096)

    renderPicker({ failures: [{ providerId: 'gateway', providerName: 'Gateway', message }] })
    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))

    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual([
      `Could not load models for Gateway: ${message}`,
    ])
    expect(screen.getByRole('menuitemradio', { name: /DeepSeek Chat/u })).toBeDefined()
  })
})

function renderPicker(
  options: {
    readonly value?: ModelSelection
    readonly models?: readonly ModelDescriptor[]
    readonly failures?: readonly ModelCatalogFailure[]
    readonly loading?: boolean
    readonly error?: string
    readonly onRetry?: () => void
    readonly disabled?: boolean
    readonly openRequest?: number
    readonly onChange?: (value: ModelSelection) => void | Promise<void>
  } = {},
): ReturnType<typeof render> {
  return render(picker(options))
}

function picker(
  options: {
    readonly value?: ModelSelection
    readonly models?: readonly ModelDescriptor[]
    readonly failures?: readonly ModelCatalogFailure[]
    readonly loading?: boolean
    readonly error?: string
    readonly onRetry?: () => void
    readonly disabled?: boolean
    readonly openRequest?: number
    readonly onChange?: (value: ModelSelection) => void | Promise<void>
  } = {},
): ReactElement {
  return (
    <I18nProvider>
      <ModelPicker
        models={options.models ?? MODELS}
        value={options.value ?? CHAT}
        {...(options.failures === undefined ? {} : { failures: options.failures })}
        {...(options.loading === undefined ? {} : { loading: options.loading })}
        {...(options.error === undefined ? {} : { error: options.error })}
        {...(options.onRetry === undefined ? {} : { onRetry: options.onRetry })}
        {...(options.disabled === undefined ? {} : { disabled: options.disabled })}
        {...(options.openRequest === undefined ? {} : { openRequest: options.openRequest })}
        onChange={options.onChange ?? vi.fn()}
      />
    </I18nProvider>
  )
}

/** The counter advances while the picker is already on screen, as `/model` does. */

/** The open request is scheduled on a macrotask, so a microtask flush is not enough. */

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Model and reasoning/u })
}

/** The visible half of the trigger label, without the accessible-name prefix. */

function openRoot(): void {
  // A real pointer click focuses the trigger before React sees the click.
  trigger().focus()
  fireEvent.click(trigger())
}

function activate(element: HTMLElement): void {
  element.focus()
  fireEvent.click(element)
}

/** Menu rows in DOM order, including the back row and the option rows. */
