// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'

import { I18nProvider } from '../../i18n.js'
import { ScheduleDrawer } from './ScheduleDrawer.js'

function featureRequest<T>(_request: FeatureRequest): Promise<T> {
  return Promise.resolve({ kind: 'schedule.catalog', items: [] } as T)
}

function Harness(): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <I18nProvider>
      <button type="button" onClick={() => setOpen(true)}>
        Open schedules
      </button>
      <ScheduleDrawer
        open={open}
        onClose={() => setOpen(false)}
        featureRequest={featureRequest}
        subscribeFeature={() => () => undefined}
        onStartScheduleSession={() => undefined}
      />
    </I18nProvider>
  )
}

describe('ScheduleDrawer', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens an accessible modal and restores focus to its trigger on Escape', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open schedules' })
    trigger.focus()
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: 'Schedules' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Close schedules' })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Schedules' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('dismisses when the backdrop is clicked', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open schedules' }))
    const backdrop = document.querySelector('.dsh-schedule-drawer__backdrop')
    if (!(backdrop instanceof HTMLElement)) throw new Error('The schedule backdrop is missing.')

    fireEvent.pointerDown(backdrop)

    expect(screen.queryByRole('dialog', { name: 'Schedules' })).toBeNull()
  })
})
