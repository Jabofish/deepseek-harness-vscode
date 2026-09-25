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
      onStartScheduleSession={options.onStartScheduleSession ?? (() => Promise.resolve('session-new'))}
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

function clickCreateOpen(): void {
  const button = document.querySelector<HTMLButtonElement>('.dsh-schedule-panel__new')
  if (button === null) throw new Error('The create schedule button is missing.')
  fireEvent.click(button)
}

function submitCreateForm(): void {
  const button = document.querySelector<HTMLButtonElement>(
    '.dsh-schedule-panel__create-form button[type="submit"]',
  )
  if (button === null) throw new Error('The create schedule submit button is missing.')
  fireEvent.click(button)
}

const timingLabels: Readonly<Record<string, string>> = {
  after: 'After a delay',
  at: 'One time',
  every: 'Every interval',
  daily: 'Daily',
  weekly: 'Weekly',
  cron: 'Cron rule',
  keep: 'Keep current timing',
}

/** The timing control is an anchored menu: open its trigger, then pick the choice. */
function chooseTiming(timing: string): void {
  fireEvent.click(screen.getByLabelText('Timing'))
  fireEvent.click(screen.getByRole('option', { name: timingLabels[timing] ?? timing }))
}

describe('SchedulePanel', () => {
  afterEach(() => cleanup())

  it('serializes each RC2 selector exactly and waits for catalog confirmation after turn end', async () => {
    const cases = [
      { timing: 'after', selector: 'after_seconds', value: 300 },
      { timing: 'at', selector: 'at', value: { date: '2099-10-20', time: '09:30:00', time_zone: 'UTC' } },
      { timing: 'every', selector: 'every_seconds', value: 300 },
      { timing: 'daily', selector: 'daily', value: { time: '10:15:00', time_zone: 'UTC' } },
      {
        timing: 'weekly',
        selector: 'weekly',
        value: { time: '10:15:00', time_zone: 'UTC', weekdays: [1, 2] },
      },
      { timing: 'cron', selector: 'cron', value: { expression: '0 9 * * 1', time_zone: 'UTC' } },
    ] as const
    for (const item of cases) {
      const startSession = vi.fn((_prompt: string) => Promise.resolve('session-new'))
      const panel = mountPanel({ onStartScheduleSession: startSession })
      await screen.findByRole('button', { name: /Water the plants/u })
      clickCreateOpen()
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Quarterly check' } })
      fireEvent.change(screen.getByLabelText('Reminder instruction'), {
        target: { value: 'Check the garden.' },
      })
      chooseTiming(item.timing)
      if (item.timing === 'at') {
        fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2099-10-20' } })
        fireEvent.change(screen.getByLabelText('Time'), { target: { value: '09:30' } })
        fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
      } else if (item.timing === 'every' || item.timing === 'after') {
        fireEvent.change(screen.getByLabelText('Interval in seconds'), { target: { value: '300' } })
      } else if (item.timing === 'daily' || item.timing === 'weekly') {
        fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
        fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
        if (item.timing === 'weekly') fireEvent.click(screen.getByRole('checkbox', { name: 'Tuesday' }))
      } else {
        fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
      }
      submitCreateForm()

      await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1))
      const instruction = startSession.mock.calls[0]?.[0]
      if (instruction === undefined) throw new Error('The create prompt was not captured.')
      expect(instruction).toContain('schedule_create')
      const args = JSON.parse(instruction.slice(instruction.lastIndexOf('\n\n') + 2)) as Record<
        string,
        unknown
      >
      expect(args).toEqual({
        title: 'Quarterly check',
        prompt: 'Check the garden.',
        [item.selector]: item.value,
      })
      expect(
        ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'].filter((key) => key in args),
      ).toHaveLength(1)
      await waitFor(() =>
        expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
      )
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).toBeNull()
      expect(document.querySelector<HTMLButtonElement>('.dsh-schedule-panel__new')?.disabled).toBe(true)
      panel.view.unmount()
    }
  })

  it('confirms only after invalidation refresh returns a matching new catalog record', async () => {
    let items: readonly ScheduleCatalogEntry[] = [active]
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.catalog'
          ? { kind: 'schedule.catalog', items }
          : defaultResponse(request, items),
      onStartScheduleSession: () => Promise.resolve('session-new'),
    })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Quarterly check' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), {
      target: { value: 'Check the garden.' },
    })
    submitCreateForm()
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )

    items = [
      ...items,
      {
        id: 'schedule-created',
        kind: 'after',
        title: 'Quarterly check',
        prompt: 'Check the garden.',
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
    act(() => panel.emit(event))
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull(),
    )
    expect(document.querySelector('.dsh-schedule-panel__create-state-title')?.textContent).toBe(
      'Quarterly check',
    )
    panel.view.unmount()
  })

  it('matches RC2 canonicalized wall times, IANA aliases, and cron fields', async () => {
    let items: readonly ScheduleCatalogEntry[] = [active]
    let sessionCount = 0
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.catalog'
          ? { kind: 'schedule.catalog', items }
          : defaultResponse(request, items),
      onStartScheduleSession: () => Promise.resolve(`session-${++sessionCount}`),
    })
    const invalidation = (localSeq: number): FeatureHostEvent => ({
      type: 'feature.event',
      name: 'schedule.invalidated',
      identity: { backendInstanceId: 'backend-one', connectionGeneration: 1, stream: 'local', localSeq },
    })
    await screen.findByRole('button', { name: /Water the plants/u })

    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Canonical daily' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Review the day.' } })
    chooseTiming('daily')
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:15' } })
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'US/Eastern' } })
    submitCreateForm()
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )
    items = [
      ...items,
      {
        id: 'schedule-daily',
        kind: 'daily',
        title: 'Canonical daily',
        prompt: 'Review the day.',
        scheduledAt: '2026-10-02T14:15:00.000Z',
        time: '10:15:00.000',
        timeZone: 'America/New_York',
        sessionId: 'session-1',
        status: 'active',
      },
    ]
    act(() => panel.emit(invalidation(2)))
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull(),
    )

    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Canonical cron' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), {
      target: { value: 'Check the service.' },
    })
    chooseTiming('cron')
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0,1 9 * * 1' } })
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
    submitCreateForm()
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )
    items = [
      ...items,
      {
        id: 'schedule-cron',
        kind: 'cron',
        title: 'Canonical cron',
        prompt: 'Check the service.',
        scheduledAt: '2026-10-05T09:00:00.000Z',
        expression: '0-1 9 * * 1',
        timeZone: 'UTC',
        sessionId: 'session-2',
        status: 'active',
      },
    ]
    act(() => panel.emit(invalidation(3)))
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull(),
    )
    expect(document.querySelector('.dsh-schedule-panel__create-state-title')?.textContent).toBe(
      'Canonical cron',
    )
    panel.view.unmount()
  })

  it('preserves the form after a failed send and allows a retry', async () => {
    const startSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValue('session-new')
    mountPanel({ onStartScheduleSession: startSession })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retry me' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Do a check.' } })
    submitCreateForm()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByLabelText('Name')).toHaveProperty('value', 'Retry me')
    submitCreateForm()
    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )
  })

  it('cancels an unsent creation form without creating a Session', async () => {
    const startSession = vi.fn(() => Promise.resolve('session-new'))
    mountPanel({ onStartScheduleSession: startSession })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(document.querySelector('.dsh-schedule-panel__create-form')).toBeNull()
    expect(startSession).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Schedules' }))
  })

  it('prevalidates the 300-second minimum, IANA zones, DST gaps, and cron grammar', async () => {
    const startSession = vi.fn(() => Promise.resolve('session-new'))
    mountPanel({ onStartScheduleSession: startSession })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Validation case' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Do a check.' } })

    chooseTiming('every')
    fireEvent.change(screen.getByLabelText('Interval in seconds'), { target: { value: '299' } })
    submitCreateForm()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(startSession).not.toHaveBeenCalled()

    chooseTiming('daily')
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Not/AZone' } })
    submitCreateForm()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(startSession).not.toHaveBeenCalled()

    chooseTiming('at')
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-08' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '02:30' } })
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } })
    submitCreateForm()
    const gapValidation = await screen.findByRole('alert')
    const gapMessage = gapValidation.textContent
    expect(startSession).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-02-30' } })
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
    submitCreateForm()
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe(gapMessage))
    expect(startSession).not.toHaveBeenCalled()

    chooseTiming('cron')
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'UTC' } })
    fireEvent.change(screen.getByLabelText('Cron expression'), { target: { value: '0 25 * * 1' } })
    submitCreateForm()
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(startSession).not.toHaveBeenCalled()
  })

  it('resolves an absolute DST overlap to the earlier instant used by RC2', async () => {
    let items: readonly ScheduleCatalogEntry[] = [active]
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.catalog'
          ? { kind: 'schedule.catalog', items }
          : defaultResponse(request, items),
      onStartScheduleSession: () => Promise.resolve('session-new'),
    })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Overlap case' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Check once.' } })
    chooseTiming('at')
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-01' } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '01:30' } })
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } })
    submitCreateForm()
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )
    items = [
      ...items,
      {
        id: 'schedule-overlap',
        kind: 'at',
        title: 'Overlap case',
        prompt: 'Check once.',
        scheduledAt: '2026-11-01T05:30:00.000Z',
        sessionId: 'session-new',
        status: 'active',
      },
    ]
    const event: FeatureHostEvent = {
      type: 'feature.event',
      name: 'schedule.invalidated',
      identity: { backendInstanceId: 'backend-one', connectionGeneration: 1, stream: 'local', localSeq: 2 },
    }
    act(() => panel.emit(event))
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--confirmed')).not.toBeNull(),
    )
    panel.view.unmount()
  })

  it('keeps Retry locked through an empty catalog while the create turn is still running', async () => {
    let finishTurn!: () => void
    let catalogReplyCount = 0
    const startSession = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishTurn = () => resolve('session-new')
        }),
    )
    const panel = mountPanel({
      items: [],
      onStartScheduleSession: startSession,
      resolve: (request) => {
        if (request.type !== 'schedule.catalog') return defaultResponse(request, [])
        catalogReplyCount += 1
        if (catalogReplyCount === 3) throw new Error('catalog not yet readable')
        return { kind: 'schedule.catalog', items: [] }
      },
    })
    await screen.findByText('No scheduled reminders yet.')
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Awaiting Agent' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Run later.' } })
    submitCreateForm()
    await waitFor(() => expect(startSession).toHaveBeenCalledTimes(1))
    expect(document.querySelector('.dsh-schedule-panel__create-state--sending')).not.toBeNull()
    const sendingState = document.querySelector<HTMLElement>('.dsh-schedule-panel__create-state--sending')
    if (sendingState === null) throw new Error('The sending state is missing.')
    expect(within(sendingState).queryByRole('button', { name: /retry/i })).toBeNull()

    const refresh = document.querySelector<HTMLButtonElement>(
      '.dsh-schedule-panel__heading-actions .dsh-schedule-panel__icon-button',
    )
    if (refresh === null) throw new Error('The catalog refresh control is missing.')
    const catalogCalls = panel.requests.filter((request) => request.type === 'schedule.catalog').length
    fireEvent.click(refresh)
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.catalog')).toHaveLength(
        catalogCalls + 1,
      ),
    )
    const form = document.querySelector<HTMLFormElement>('.dsh-schedule-panel__create-form')
    if (form === null) throw new Error('The create form is missing.')
    fireEvent.submit(form)
    expect(startSession).toHaveBeenCalledTimes(1)
    expect(within(sendingState).queryByRole('button', { name: /retry/i })).toBeNull()

    await act(async () => {
      finishTurn()
      await Promise.resolve()
    })
    await waitFor(() => {
      expect(catalogReplyCount).toBe(3)
      expect(document.querySelector('.dsh-schedule-panel__create-state--pending')).not.toBeNull()
    })
    const pendingState = document.querySelector<HTMLElement>('.dsh-schedule-panel__create-state--pending')
    if (pendingState === null) throw new Error('The pending state is missing.')
    expect(within(pendingState).queryByRole('button', { name: /retry/i })).toBeNull()
    const check = within(pendingState).getByRole<HTMLButtonElement>('button', { name: /check/i })
    await waitFor(() => expect(check.disabled).toBe(false))
    fireEvent.click(check)
    await waitFor(() =>
      expect(document.querySelector('.dsh-schedule-panel__create-state--unconfirmed')).not.toBeNull(),
    )
    const unconfirmedState = document.querySelector<HTMLElement>(
      '.dsh-schedule-panel__create-state--unconfirmed',
    )
    if (unconfirmedState === null) throw new Error('The unconfirmed state is missing.')
    expect(within(unconfirmedState).getByRole('button', { name: /retry/i })).toBeDefined()
    panel.view.unmount()
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
    chooseTiming('weekly')
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

  it('sets the edited recurring interval minimum to the upstream 300-second limit', async () => {
    mountPanel({ items: [recurring] })
    fireEvent.click(await screen.findByRole('button', { name: /Check the build/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    chooseTiming('every')

    expect(screen.getByLabelText('Interval in seconds').getAttribute('min')).toBe('300')
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
    expect(document.querySelector('.dsh-schedule-panel__new')).not.toBeNull()
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
