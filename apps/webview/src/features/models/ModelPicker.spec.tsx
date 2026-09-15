// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { ModelDescriptor, ModelSelection } from '@dsh-vscode/domain'

import { I18nProvider } from '../../i18n.js'
import { ModelPicker } from './ModelPicker.js'

const MODELS: readonly ModelDescriptor[] = [
  { id: 'deepseek-chat', providerId: 'deepseek', label: 'DeepSeek Chat', supportsReasoning: false },
  {
    id: 'deepseek-reasoner',
    providerId: 'deepseek',
    label: 'DeepSeek Reasoner',
    supportsReasoning: true,
    reasoningLevels: ['low', 'high'],
  },
  {
    id: 'claude-sonnet',
    providerId: 'anthropic',
    label: 'Claude Sonnet',
    supportsReasoning: true,
    reasoningLevels: ['low', 'high'],
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

    expect(onChange).toHaveBeenCalledWith({
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      reasoningLevel: 'low',
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('returns focus to the trigger after choosing a reasoning level', () => {
    const onChange = vi.fn()
    renderPicker({ value: REASONER, onChange })

    openRoot()
    activate(screen.getByRole('menuitem', { name: /^Reasoning effort/u }))
    activate(screen.getByRole('menuitemradio', { name: 'high' }))

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
