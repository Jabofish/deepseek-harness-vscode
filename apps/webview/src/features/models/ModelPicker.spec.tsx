// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ModelCatalogFailure, ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { ModelPicker } from './ModelPicker.js'

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

describe('ModelPicker keyboard and focus contract', () => {
  afterEach(() => cleanup())

  it('opens from ArrowDown on the trigger and moves focus to the first row', () => {
    renderPicker()

    fireEvent.keyDown(trigger(), { key: 'ArrowDown' })

    expect(screen.getByRole('menu')).toBeDefined()
    expect(focusedIndex()).toBe(0)
  })

  it('opens from ArrowUp on the trigger and moves focus to the last row', () => {
    renderPicker({ value: REASONER })

    fireEvent.keyDown(trigger(), { key: 'ArrowUp' })

    expect(screen.getByRole('menu')).toBeDefined()
    expect(focusedIndex()).toBe(menuItems().length - 1)
  })

  it('returns focus to the trigger after choosing a model', () => {
    const onChange = vi.fn()
    renderPicker({ onChange })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))
    activate(screen.getByRole('menuitemradio', { name: /DeepSeek Reasoner/u }))

    // The route alone: the adapter resolves the effort for a model the session
    // was not asked about yet, so the picker must not name a level for it.
    expect(onChange).toHaveBeenCalledWith({
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('returns focus to the trigger after choosing a reasoning level', () => {
    const onChange = vi.fn()
    renderPicker({ value: REASONER, onChange })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Reasoning effort/u }))
    activate(screen.getByRole('menuitemradio', { name: 'High' }))

    expect(onChange).toHaveBeenCalledWith({
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      reasoningLevel: 'high',
    })
    expect(document.activeElement).toBe(trigger())
  })

  it('keeps the keyboard inside the pane after switching panes', () => {
    renderPicker({ value: REASONER })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))

    const before = focusedIndex()
    expect(before).toBeGreaterThanOrEqual(0)
    fireEvent.keyDown(menuItems()[before] ?? document.body, { key: 'ArrowDown' })
    expect(focusedIndex()).toBe(((before ?? 0) + 1) % menuItems().length)
  })

  it('returns from a nested pane to the root pane without closing the menu', () => {
    renderPicker({ value: REASONER })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))
    expect(screen.getAllByRole('menuitemradio').length).toBeGreaterThan(0)

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.getByRole('menu')).toBeDefined()
    expect(screen.getByRole('menuitem', { name: /^Reasoning effort/u })).toBeDefined()
  })

  it('closes on Escape from the root pane and restores focus to the trigger', () => {
    renderPicker()

    openRoot()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('wraps arrow navigation around the menu rows', () => {
    renderPicker({ value: REASONER })

    openRoot()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' })
    expect(focusedIndex()).toBe(menuItems().length - 1)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(focusedIndex()).toBe(0)
  })

  it('preserves the current reasoning level when the same model is chosen again', () => {
    const onChange = vi.fn()
    renderPicker({
      value: { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'high' },
      onChange,
    })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))
    activate(screen.getByRole('menuitemradio', { name: /DeepSeek Reasoner/u }))

    expect(onChange).toHaveBeenCalledWith({
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      reasoningLevel: 'high',
    })
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

  it('keeps the menu reachable when every provider failed', () => {
    renderPicker({
      models: [],
      failures: [{ providerId: 'gateway', providerName: 'Gateway', message: 'connection refused' }],
    })

    expect((trigger() as HTMLButtonElement).disabled).toBe(false)
    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Model/u }))

    expect(screen.getAllByRole('status').map((node) => node.textContent)).toEqual([
      'Could not load models for Gateway: connection refused',
      'No models are available for this session.',
    ])
  })
})

describe('ModelPicker seat statements', () => {
  afterEach(() => cleanup())

  it('names an unlisted route with the host identifiers instead of a verdict of its own', () => {
    // The catalog is advisory: a provider that could not enumerate reports its
    // reason as a warning row, and the host states routability separately, so
    // the seat may not call the session's own model unavailable.
    renderPicker({
      value: { providerId: 'gateway', modelId: 'gateway-chat' },
      failures: [{ providerId: 'gateway', providerName: 'Gateway', message: 'connection refused' }],
    })

    expect(triggerLabel()).toBe('gateway/gateway-chat')
  })

  it('states the level the adapter declared when the session names none', () => {
    renderPicker({ value: { providerId: 'anthropic', modelId: 'claude-sonnet' } })

    expect(triggerLabel()).toBe('Claude Sonnet · High')
  })

  it('says the adapter resolves the effort when it declares no default', () => {
    renderPicker({ value: { providerId: 'deepseek', modelId: 'deepseek-reasoner' } })

    expect(triggerLabel()).toBe('DeepSeek Reasoner · Provider default')
  })

  it('shows the level the session stated instead of the declared default', () => {
    renderPicker({
      value: { providerId: 'anthropic', modelId: 'claude-sonnet', reasoningLevel: 'low' },
    })

    expect(triggerLabel()).toBe('Claude Sonnet · Low')
  })

  it('renders a stated level the adapter does not list by its id', () => {
    renderPicker({
      value: { providerId: 'anthropic', modelId: 'claude-sonnet', reasoningLevel: 'max' },
    })

    expect(triggerLabel()).toBe('Claude Sonnet · max')
  })

  it('offers the provider default row when the adapter declared no default', () => {
    renderPicker({ value: { providerId: 'deepseek', modelId: 'deepseek-reasoner' } })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Reasoning effort/u }))

    expect(screen.getByRole('menuitemradio', { name: 'Provider default' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Low' }).getAttribute('aria-checked')).toBe('false')
  })

  it('checks the declared default and offers no provider default row when one is declared', () => {
    renderPicker({ value: { providerId: 'anthropic', modelId: 'claude-sonnet' } })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Reasoning effort/u }))

    expect(screen.queryByRole('menuitemradio', { name: 'Provider default' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
  })

  it('returns the effort to the adapter by clearing an explicit level', () => {
    const onChange = vi.fn()
    renderPicker({
      value: { providerId: 'deepseek', modelId: 'deepseek-reasoner', reasoningLevel: 'high' },
      onChange,
    })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Reasoning effort/u }))
    expect(screen.getByRole('menuitemradio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
    activate(screen.getByRole('menuitemradio', { name: 'Provider default' }))

    expect(onChange).toHaveBeenCalledWith({ providerId: 'deepseek', modelId: 'deepseek-reasoner' })
  })
})

describe('ModelPicker open requests', () => {
  afterEach(() => cleanup())

  it('opens when the request counter advances while the picker is on screen', async () => {
    const view = renderPicker()

    deliverRequest(view)

    expect(await screen.findByRole('menu')).toBeDefined()
  })

  it('resolves a requested open only once when the run state flips afterwards', async () => {
    const view = renderPicker()
    deliverRequest(view)
    await screen.findByRole('menu')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    // Sending a prompt disables the controls for the length of the turn.
    view.rerender(picker({ disabled: true, openRequest: 1 }))
    view.rerender(picker({ disabled: false, openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('resolves a requested open only once when the model directory changes afterwards', async () => {
    const view = renderPicker()
    deliverRequest(view)
    await screen.findByRole('menu')

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()

    view.rerender(picker({ models: MODELS.slice(0, 2), openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens once the directory arrives when the request found no models yet', async () => {
    const view = renderPicker({ models: [] })
    deliverRequest(view, { models: [] })
    await flushOpenRequest()
    expect(screen.queryByRole('menu')).toBeNull()

    view.rerender(picker({ models: MODELS, openRequest: 1 }))
    await screen.findByRole('menu')

    expect(screen.getByRole('menu')).toBeDefined()
  })

  it('does not spend a stale request again when the picker remounts', async () => {
    const view = renderPicker()
    deliverRequest(view)
    await screen.findByRole('menu')
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    view.unmount()

    // A permission prompt unmounts the composer's controls; approving brings
    // the picker back with the counter still holding the spent request.
    render(picker({ openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('menu')).toBeNull()
  })
})

function renderPicker(
  options: {
    readonly value?: ModelSelection
    readonly models?: readonly ModelDescriptor[]
    readonly failures?: readonly ModelCatalogFailure[]
    readonly disabled?: boolean
    readonly openRequest?: number
    readonly onChange?: (value: ModelSelection) => void
  } = {},
): ReturnType<typeof render> {
  return render(picker(options))
}

function picker(
  options: {
    readonly value?: ModelSelection
    readonly models?: readonly ModelDescriptor[]
    readonly failures?: readonly ModelCatalogFailure[]
    readonly disabled?: boolean
    readonly openRequest?: number
    readonly onChange?: (value: ModelSelection) => void
  } = {},
): ReactElement {
  return (
    <I18nProvider>
      <ModelPicker
        models={options.models ?? MODELS}
        value={options.value ?? CHAT}
        {...(options.failures === undefined ? {} : { failures: options.failures })}
        {...(options.disabled === undefined ? {} : { disabled: options.disabled })}
        {...(options.openRequest === undefined ? {} : { openRequest: options.openRequest })}
        onChange={options.onChange ?? vi.fn()}
      />
    </I18nProvider>
  )
}

/** The counter advances while the picker is already on screen, as `/model` does. */
function deliverRequest(view: ReturnType<typeof render>, options: Parameters<typeof picker>[0] = {}): void {
  view.rerender(picker({ ...options, openRequest: 1 }))
}

/** The open request is scheduled on a macrotask, so a microtask flush is not enough. */
async function flushOpenRequest(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Model and reasoning/u })
}

/** The visible half of the trigger label, without the accessible-name prefix. */
function triggerLabel(): string {
  const text = trigger().querySelector('.dsh-select-menu__trigger-text')
  return text?.textContent ?? ''
}

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
function menuItems(): readonly HTMLElement[] {
  const menu = screen.queryByRole('menu')
  if (menu === null) return []
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'))
}

function focusedIndex(): number {
  return menuItems().findIndex((item) => item === document.activeElement)
}
