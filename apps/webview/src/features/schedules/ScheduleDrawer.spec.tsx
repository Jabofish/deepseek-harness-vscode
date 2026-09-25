// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleCatalogEntry } from '@dsh-vscode/domain'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'

import { I18nProvider } from '../../i18n.js'
import { ScheduleDrawer, type ScheduleDrawerProps } from './ScheduleDrawer.js'

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
        onStartScheduleSession={() => Promise.resolve('session-new')}
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

  it('keeps the pending create listener mounted while the user closes and reopens the drawer', async () => {
    let items: readonly ScheduleCatalogEntry[] = []
    let catalogCalls = 0
    const listeners = new Set<(message: FeatureHostEvent) => void>()
    const featureRequestForTest: ScheduleDrawerProps['featureRequest'] = <T,>(
      request: FeatureRequest,
    ): Promise<T> => {
      if (request.type === 'schedule.catalog') {
        catalogCalls += 1
        return Promise.resolve({ kind: 'schedule.catalog', items } as T)
      }
      return Promise.resolve(undefined as T)
    }
    const startSchedule = (): Promise<string> => Promise.resolve('session-new')
    const subscribeFeature: ScheduleDrawerProps['subscribeFeature'] = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function PersistentHarness(): ReactElement {
      const [open, setOpen] = useState(false)
      return (
        <I18nProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Open schedules
          </button>
          <ScheduleDrawer
            open={open}
            onClose={() => setOpen(false)}
            featureRequest={featureRequestForTest}
            subscribeFeature={subscribeFeature}
            onStartScheduleSession={startSchedule}
          />
        </I18nProvider>
      )
    }

    render(<PersistentHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open schedules' }))
    await screen.findByText('No scheduled reminders yet.')
    const createButton = document.querySelector<HTMLButtonElement>('.dsh-schedule-panel__new')
    if (createButton === null) throw new Error('The create button is missing.')
    fireEvent.click(createButton)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep listening' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Run later.' } })
    const submit = document.querySelector<HTMLButtonElement>(
      '.dsh-schedule-panel__create-form button[type="submit"]',
    )
    if (submit === null) throw new Error('The create submit button is missing.')
    fireEvent.click(submit)
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--pending')).not.toBeNull(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close schedules' }))
    expect(screen.queryByRole('dialog', { name: 'Schedules' })).toBeNull()
    expect(catalogCalls).toBe(2)
    items = [
      {
        id: 'schedule-created',
        kind: 'after',
        title: 'Keep listening',
        prompt: 'Run later.',
        scheduledAt: '2026-10-01T09:00:00.000Z',
        afterSeconds: 300,
        sessionId: 'session-new',
        status: 'active',
      },
    ]
    const event: FeatureHostEvent = {
      type: 'feature.event',
      name: 'schedule.invalidated',
      identity: { backendInstanceId: 'backend-one', connectionGeneration: 1, stream: 'local', localSeq: 2 },
    }
    act(() => {
      for (const listener of listeners) listener(event)
    })
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open schedules' }))
    expect(screen.getByRole('dialog', { name: 'Schedules' })).toBeDefined()
    expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull()
    expect(catalogCalls).toBe(3)
  })
})
