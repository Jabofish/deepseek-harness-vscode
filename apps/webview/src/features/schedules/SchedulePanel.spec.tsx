// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleCatalogEntry, ScheduleDeliveryRecord, ScheduleRecord } from '@dsh-vscode/domain'
import type { FeatureHostEvent, FeatureRequest } from '@dsh-vscode/webview-protocol'
import { SchedulePanel, type SchedulePanelProps } from './SchedulePanel.js'

const active: ScheduleCatalogEntry = {
  id: 'schedule-one',
  kind: 'at',
  title: 'Water the plants',
  prompt: 'Remind me to water the plants.',
  scheduledAt: '2026-10-02T09:00:00.000Z',
  sessionId: 'session-original',
  status: 'active',
}

const ended: ScheduleCatalogEntry = {
  id: 'schedule-ended',
  kind: 'every',
  title: 'Old reminder',
  prompt: 'An ended reminder.',
  scheduledAt: '2026-09-01T09:00:00.000Z',
  everySeconds: 3_600,
  sessionId: 'session-old',
  status: 'inactive',
}

const recurring: ScheduleCatalogEntry = {
  id: 'schedule-every',
  kind: 'every',
  title: 'Check the build',
  prompt: 'Check the build status.',
  scheduledAt: '2026-10-01T09:00:00.000Z',
  everySeconds: 3_600,
  sessionId: 'session-original',
  status: 'active',
}

const delivery: ScheduleDeliveryRecord = {
  scheduledAt: '2026-10-01T09:00:00.000Z',
  deliveredAt: '2026-10-01T09:00:02.000Z',
  messageId: 'delivery-one',
  prompt: 'Remind me to water the plants.',
}

interface MountedPanel {
  readonly view: ReturnType<typeof render>
  readonly requests: FeatureRequest[]
  readonly emit: (event: FeatureHostEvent) => void
}

function mountPanel(
  options: {
    readonly items?: readonly ScheduleCatalogEntry[]
    readonly resolve?: (request: FeatureRequest) => unknown
    readonly onStartScheduleSession?: SchedulePanelProps['onStartScheduleSession']
  } = {},
): MountedPanel {
  const requests: FeatureRequest[] = []
  const listeners = new Set<(message: FeatureHostEvent) => void>()
  const featureRequest: SchedulePanelProps['featureRequest'] = async <T,>(
    request: FeatureRequest,
  ): Promise<T> => {
    requests.push(request)
    return (await (options.resolve?.(request) ??
      defaultResponse(request, options.items ?? [active, ended]))) as T
  }
  const subscribeFeature: SchedulePanelProps['subscribeFeature'] = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  const view = render(
    <SchedulePanel
      featureRequest={featureRequest}
      subscribeFeature={subscribeFeature}
      onStartScheduleSession={options.onStartScheduleSession ?? (() => undefined)}
    />,
  )
  return {
    view,
    requests,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
}

function defaultResponse(request: FeatureRequest, items: readonly ScheduleCatalogEntry[]): unknown {
  switch (request.type) {
    case 'schedule.catalog':
      return { kind: 'schedule.catalog', items }
    case 'schedule.history':
      return {
        kind: 'schedule.history',
        result: {
          id: request.payload.id,
          records: [delivery],
          earlierRecordsUnavailable: true,
          earlierRecordsPruned: true,
          retention: { days: 30, records: 500 },
          nextBefore: 'delivery-one',
        },
      }
    case 'schedule.update': {
      const record = { ...request.payload.expected, ...request.payload.change } as ScheduleRecord
      return { kind: 'schedule.updated', result: { id: request.payload.id, updated: true, record } }
    }
    case 'schedule.delete':
      return { kind: 'schedule.deleted', result: { id: request.payload.id, deleted: true } }
    default:
      return undefined
  }
}

describe('SchedulePanel', () => {
  afterEach(() => cleanup())

  it('starts the real creation flow through a new Session callback and supports retry after failure', async () => {
    const startSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue(undefined)
    mountPanel({ onStartScheduleSession: startSession })

    const createButton = await screen.findByRole('button', { name: 'Start a session to create a reminder' })
    fireEvent.click(createButton)
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not start a session for a new reminder.',
    )
    expect(startSession).toHaveBeenCalledTimes(1)

    fireEvent.click(createButton)
    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('loads, searches and filters the catalog without losing its total count', async () => {
    mountPanel()
    const list = await screen.findByRole('list', { name: 'Scheduled reminders' })
    expect(within(list).getByText('Water the plants')).toBeDefined()
    expect(within(list).getByText('Old reminder')).toBeDefined()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search schedules' }), {
      target: { value: 'old' },
    })
    expect(screen.getByRole('status').textContent).toContain('1 of 2 schedules')
    expect(within(list).queryByText('Water the plants')).toBeNull()
    expect(within(list).getByText('Old reminder')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Active' }))
    expect(screen.getByText('No schedules match this search.')).toBeDefined()
  })

  it('keeps an accessible detail disclosure and returns focus when Escape closes it', async () => {
    mountPanel()
    const row = await screen.findByRole('button', { name: /Water the plants/u })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const detailId = row.getAttribute('aria-controls')
    expect(detailId).not.toBeNull()
    expect(document.getElementById(detailId as string)).not.toBeNull()

    fireEvent.keyDown(row, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(row))
    expect(screen.queryByRole('complementary', { name: 'Schedule details' })).toBeNull()
  })

  it('supports arrow-key movement through related detail tabs', async () => {
    mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    const ruleTab = screen.getByRole('tab', { name: 'Reminder' })
    const historyTab = screen.getByRole('tab', { name: 'Delivery history' })
    fireEvent.keyDown(ruleTab, { key: 'ArrowRight' })

    expect(historyTab.getAttribute('aria-selected')).toBe('true')
    expect(historyTab.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(historyTab)
    expect(screen.getByRole('tabpanel', { name: 'Delivery history' }).hasAttribute('hidden')).toBe(false)
  })

  it('edits a timing rule against its original Session and sends a fresh compare-and-swap snapshot', async () => {
    const { requests } = mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'weekly' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tuesday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.update')).toBe(true))
    const request = requests.find((item) => item.type === 'schedule.update')
    expect(request).toMatchObject({
      payload: {
        sessionId: 'session-original',
        id: 'schedule-one',
        expected: { kind: 'at', id: 'schedule-one', title: 'Water the plants' },
        change: { kind: 'weekly', weekdays: [1, 2] },
      },
    })
  })

  it('retains delivery and retention metadata and requests older history with the returned cursor', async () => {
    const { requests } = mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))

    const history = await screen.findByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).getByText('Remind me to water the plants.')).toBeDefined()
    expect(within(history).getByText(/Some earlier delivery records/u)).toBeDefined()
    expect(within(history).getByText(/Older delivery records were removed/u)).toBeDefined()
    expect(within(history).getByText('History is retained for 30 days, up to 500 deliveries.')).toBeDefined()
    fireEvent.click(within(history).getByRole('button', { name: 'Load older deliveries' }))

    await waitFor(() => {
      const pages = requests.filter((request) => request.type === 'schedule.history')
      expect(pages).toHaveLength(2)
      expect(pages[1]).toMatchObject({ payload: { before: 'delivery-one', sessionId: 'session-original' } })
    })
  })

  it('requires confirmation before deleting through the Host and refreshes the catalog', async () => {
    let deleted = false
    const { requests } = mountPanel({
      resolve: (request) => {
        if (request.type === 'schedule.delete') {
          deleted = true
          return { kind: 'schedule.deleted', result: { id: request.payload.id, deleted: true } }
        }
        if (request.type === 'schedule.catalog' && deleted) return { kind: 'schedule.catalog', items: [] }
        return defaultResponse(request, [active, ended])
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete reminder' }))

    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.delete')).toBe(true))
    const deleteRequest = requests.find((request) => request.type === 'schedule.delete')
    expect(deleteRequest).toMatchObject({ payload: { sessionId: 'session-original', id: 'schedule-one' } })
    expect(await screen.findByText('No scheduled reminders yet.')).toBeDefined()
  })

  it('keeps completed reminders inspectable and allows deletion but not editing', async () => {
    const { requests } = mountPanel({ items: [ended] })
    fireEvent.click(await screen.findByRole('button', { name: /Old reminder/u }))
    expect(screen.getByText('This reminder has ended. Its delivery history remains available.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Edit' }).hasAttribute('disabled')).toBe(true)
    const deleteButton = screen.getByRole('button', { name: 'Delete' })
    expect(deleteButton.hasAttribute('disabled')).toBe(false)

    fireEvent.click(deleteButton)
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete reminder' }))

    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.delete')).toBe(true))
    expect(requests.find((request) => request.type === 'schedule.delete')).toMatchObject({
      payload: { sessionId: 'session-old', id: 'schedule-ended' },
    })
  })

  it('sets the edited recurring interval minimum to the upstream 60-second limit', async () => {
    mountPanel({ items: [recurring] })
    fireEvent.click(await screen.findByRole('button', { name: /Check the build/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'every' } })

    expect(screen.getByLabelText('Interval in seconds').getAttribute('min')).toBe('60')
  })

  it('refreshes after Host invalidation and exposes retry after a catalog failure', async () => {
    let catalogCalls = 0
    const panel = mountPanel({
      resolve: (request) => {
        if (request.type !== 'schedule.catalog') return defaultResponse(request, [active])
        catalogCalls += 1
        if (catalogCalls === 1) throw new Error('temporary failure')
        return { kind: 'schedule.catalog', items: [active] }
      },
    })
    const failedNotice = await screen.findByRole('alert')
    fireEvent.click(within(failedNotice).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Water the plants')).toBeDefined()

    const event: FeatureHostEvent = {
      type: 'feature.event',
      name: 'schedule.invalidated',
      identity: { backendInstanceId: 'backend-one', connectionGeneration: 1, stream: 'local', localSeq: 2 },
    }
    act(() => panel.emit(event))
    await waitFor(() => expect(catalogCalls).toBe(3))
  })

  it('shows a genuine empty state when the Host catalog contains no reminders', async () => {
    mountPanel({ items: [] })
    expect(await screen.findByText('No scheduled reminders yet.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Start a session to create a reminder' })).toBeDefined()
  })

  it('cancels outstanding feature requests when disposed', async () => {
    const pending = new Promise<unknown>(() => undefined)
    const panel = mountPanel({
      resolve: (request) => (request.type === 'schedule.catalog' ? pending : undefined),
    })
    await waitFor(() =>
      expect(panel.requests.some((request) => request.type === 'schedule.catalog')).toBe(true),
    )
    const catalog = panel.requests.find((request) => request.type === 'schedule.catalog')
    panel.view.unmount()
    expect(
      panel.requests.some(
        (request) =>
          request.type === 'feature.request.cancel' && request.payload.targetRequestId === catalog?.requestId,
      ),
    ).toBe(true)
  })
})
