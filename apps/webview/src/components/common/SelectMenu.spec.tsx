// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { SelectMenu, type SelectMenuOption } from './SelectMenu.js'

const MODE_OPTIONS: readonly SelectMenuOption[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'plan', label: 'Plan', disabled: true },
  { value: 'act', label: 'Act' },
  { value: 'debug', label: 'Debug' },
  { value: 'review', label: 'Review' },
]

describe('SelectMenu keyboard navigation', () => {
  afterEach(() => cleanup())

  it('moves up to the nearest enabled option above a disabled entry', () => {
    renderMenu({ value: 'act' })
    openMenu()

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' })

    expect(focusedOptionLabel()).toBe('Ask')
  })

  it('moves down to the nearest enabled option below a disabled entry', () => {
    renderMenu({ value: 'ask' })
    openMenu()

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowDown' })

    expect(focusedOptionLabel()).toBe('Act')
  })

  it('wraps upward from the first enabled option to the last enabled option', () => {
    renderMenu({
      value: 'ask',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan', disabled: true },
        { value: 'act', label: 'Act' },
      ],
    })
    openMenu()

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' })

    expect(focusedOptionLabel()).toBe('Act')
  })

  it('ends on the nearest enabled option when the last entry is disabled', () => {
    renderMenu({
      value: 'ask',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'act', label: 'Act' },
        { value: 'plan', label: 'Plan', disabled: true },
      ],
    })
    openMenu()

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' })

    expect(focusedOptionLabel()).toBe('Act')
  })

  it('focuses the nearest enabled option when the entry below the selection is disabled', () => {
    renderMenu({
      value: 'ask',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan', disabled: true },
        { value: 'act', label: 'Act' },
      ],
    })

    fireEvent.keyDown(screen.getByRole('button', { name: /Workflow mode/ }), { key: 'ArrowDown' })

    expect(screen.getByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
    expect(focusedOptionLabel()).toBe('Act')
  })

  it('focuses the nearest enabled option when the entry above the selection is disabled', () => {
    renderMenu({
      value: 'act',
      options: [
        { value: 'ask', label: 'Ask' },
        { value: 'plan', label: 'Plan', disabled: true },
        { value: 'act', label: 'Act' },
      ],
    })

    fireEvent.keyDown(screen.getByRole('button', { name: /Workflow mode/ }), { key: 'ArrowUp' })

    expect(screen.getByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
    expect(focusedOptionLabel()).toBe('Ask')
  })

  it('starts on the first enabled option when the first entry is disabled', () => {
    renderMenu({
      value: 'act',
      options: [
        { value: 'legacy', label: 'Legacy', disabled: true },
        { value: 'act', label: 'Act' },
        { value: 'debug', label: 'Debug' },
      ],
    })
    openMenu()

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Home' })

    expect(focusedOptionLabel()).toBe('Act')
  })

  // A value that is not among the options (the Host can report a model or mode
  // this build does not list) must not leave the menu open with nothing focused:
  // `indexOfValue` falls back to the first enabled entry and the open step is
  // measured from there.
  it('focuses the last enabled option when an unlisted value opens the menu upward', () => {
    renderMenu({ value: 'unlisted' })

    fireEvent.keyDown(screen.getByRole('button', { name: /Workflow mode/ }), { key: 'ArrowUp' })

    expect(screen.getByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
    expect(focusedOptionLabel()).toBe('Review')
  })

  it('focuses the first enabled option below the fallback when an unlisted value opens downward', () => {
    renderMenu({ value: 'unlisted' })

    fireEvent.keyDown(screen.getByRole('button', { name: /Workflow mode/ }), { key: 'ArrowDown' })

    expect(focusedOptionLabel()).toBe('Act')
  })
})

describe('SelectMenu open requests', () => {
  afterEach(() => cleanup())

  it('opens when the request counter advances while the menu is on screen', async () => {
    const view = renderMenu({ value: 'act' })

    deliverRequest(view, { value: 'act' })

    expect(await screen.findByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
  })

  it('resolves a requested open only once when the selected value changes afterwards', async () => {
    const view = renderMenu({ value: 'act' })
    deliverRequest(view, { value: 'act' })
    await screen.findByRole('listbox', { name: 'Workflow mode' })

    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Workflow mode' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()

    view.rerender(menu({ value: 'debug', openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()
  })

  it('resolves a requested open only once when the option list changes afterwards', async () => {
    const view = renderMenu({ value: 'act' })
    deliverRequest(view, { value: 'act' })
    await screen.findByRole('listbox', { name: 'Workflow mode' })

    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Workflow mode' }), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()

    view.rerender(menu({ value: 'act', options: MODE_OPTIONS.slice(0, 3), openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()
  })

  it('opens once the options arrive when the request found none yet', async () => {
    const view = renderMenu({ value: 'act', options: [] })
    deliverRequest(view, { value: 'act', options: [] })
    await flushOpenRequest()
    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()

    view.rerender(menu({ value: 'act', openRequest: 1 }))
    await screen.findByRole('listbox', { name: 'Workflow mode' })

    expect(screen.getByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
  })

  it('does not spend a stale request again when the menu remounts', async () => {
    const view = renderMenu({ value: 'act' })
    deliverRequest(view, { value: 'act' })
    await screen.findByRole('listbox', { name: 'Workflow mode' })
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Workflow mode' }), { key: 'Escape' })
    view.unmount()

    render(menu({ value: 'act', openRequest: 1 }))
    await flushOpenRequest()

    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()
  })
})

function renderMenu({
  value,
  options = MODE_OPTIONS,
  openRequest,
}: {
  readonly value: string
  readonly options?: readonly SelectMenuOption[]
  readonly openRequest?: number | undefined
}): ReturnType<typeof render> {
  return render(menu({ value, options, openRequest }))
}

function menu({
  value,
  options = MODE_OPTIONS,
  openRequest,
}: {
  readonly value: string
  readonly options?: readonly SelectMenuOption[]
  readonly openRequest?: number | undefined
}): ReactElement {
  return (
    <SelectMenu
      icon="sparkles"
      label="Act"
      ariaLabel="Workflow mode"
      title="Workflow mode"
      value={value}
      options={options}
      {...(openRequest === undefined ? {} : { openRequest })}
      onChange={vi.fn()}
    />
  )
}

/** The counter advances while the menu is already on screen. */
function deliverRequest(view: ReturnType<typeof render>, options: Parameters<typeof menu>[0]): void {
  view.rerender(menu({ ...options, openRequest: 1 }))
}

/** The open request is scheduled on a macrotask, so a microtask flush is not enough. */
async function flushOpenRequest(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function openMenu(): void {
  fireEvent.click(screen.getByRole('button', { name: /Workflow mode/ }))
}

function focusedOptionLabel(): string | undefined {
  const active = document.activeElement
  return active instanceof HTMLElement && active.getAttribute('role') === 'option'
    ? (active.textContent ?? undefined)
    : undefined
}
