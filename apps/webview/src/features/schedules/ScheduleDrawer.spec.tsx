// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleCatalogEntry } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'

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
        getLinkedSession={() => ({ status: 'missing' })}
        onOpenLinkedSession={() => undefined}
        connectionEpoch={0}
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
    expect(trigger.closest('[inert]')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Close schedules' })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Schedules' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(trigger.closest('[inert]')).toBeNull()
  })

  it('cycles Tab through visible controls when the inactive history panel contains buttons', async () => {
    const record: ScheduleCatalogEntry = {
      id: 'schedule-one',
      kind: 'at',
      title: 'Water the plants',
      prompt: 'Remind me to water the plants.',
      scheduledAt: '2035-05-06T09:00:00.000Z',
      sessionId: 'session-one',
      status: 'active',
    }
    const featureRequestForTest: ScheduleDrawerProps['featureRequest'] = <T,>(
      request: FeatureRequest,
    ): Promise<T> => {
      if (request.type === 'schedule.catalog')
        return Promise.resolve({ kind: 'schedule.catalog', items: [record] } as T)
      if (request.type === 'schedule.history')
        return Promise.resolve({
          kind: 'schedule.history',
          result: {
            id: record.id,
            records: [],
            earlierRecordsUnavailable: false,
            earlierRecordsPruned: false,
            retention: { days: 30, records: 500 },
            nextBefore: 'older-delivery',
          },
        } as T)
      return Promise.resolve(undefined as T)
    }

    render(
      <I18nProvider>
        <ScheduleDrawer
          open
          onClose={() => undefined}
          featureRequest={featureRequestForTest}
          subscribeFeature={() => () => undefined}
          onStartScheduleSession={() => Promise.resolve('session-new')}
          getLinkedSession={() => ({ status: 'missing' })}
          onOpenLinkedSession={() => undefined}
          connectionEpoch={0}
        />
      </I18nProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    const loadOlder = await screen.findByRole('button', { name: 'Load older deliveries' })
    const historyPanel = screen.getByRole('tabpanel', { name: 'Delivery history' })
    expect(historyPanel.contains(loadOlder)).toBe(true)

    fireEvent.click(screen.getByRole('tab', { name: 'Reminder' }))
    expect(historyPanel.hasAttribute('hidden')).toBe(true)

    const dialog = screen.getByRole('dialog', { name: 'Schedules' })
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const visibleFocusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter(
      (element) => element.closest('[hidden]') === null && element.getAttribute('aria-hidden') !== 'true',
    )
    const first = visibleFocusable[0]
    const last = visibleFocusable.at(-1)
    if (first === undefined || last === undefined) throw new Error('The dialog controls are missing.')

    last.focus()
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(first)
  })
})
