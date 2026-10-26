// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { SelectMenu, type SelectMenuOption } from './SelectMenu.js'

afterEach(() => vi.useRealTimers())

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

  // A value that is not among the options (the Host can report a model or mode
  // this build does not list) must not leave the menu open with nothing focused:
  // `indexOfValue` falls back to the first enabled entry and the open step is
  // measured from there.
})

describe('SelectMenu open requests', () => {
  afterEach(() => cleanup())

  it('opens once the options arrive when the request found none yet', async () => {
    const view = renderMenu({ value: 'act', options: [] })
    deliverRequest(view, { value: 'act', options: [] })
    await flushOpenRequest()
    expect(screen.queryByRole('listbox', { name: 'Workflow mode' })).toBeNull()

    view.rerender(menu({ value: 'act', openRequest: 1 }))
    await screen.findByRole('listbox', { name: 'Workflow mode' })

    expect(screen.getByRole('listbox', { name: 'Workflow mode' })).toBeDefined()
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
