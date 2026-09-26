// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
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
  readonly setConnectionEpoch: (epoch: number) => void
}

function mountPanel(
  options: {
    readonly items?: readonly ScheduleCatalogEntry[]
    readonly resolve?: (request: FeatureRequest) => unknown
    readonly onStartScheduleSession?: SchedulePanelProps['onStartScheduleSession']
    readonly getLinkedSession?: SchedulePanelProps['getLinkedSession']
    readonly onOpenLinkedSession?: SchedulePanelProps['onOpenLinkedSession']
    readonly connectionEpoch?: number
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
  let connectionEpoch = options.connectionEpoch ?? 0
  const panel = (): ReactElement => (
    <SchedulePanel
      featureRequest={featureRequest}
      subscribeFeature={subscribeFeature}
      onStartScheduleSession={options.onStartScheduleSession ?? (() => Promise.resolve('session-new'))}
      getLinkedSession={options.getLinkedSession ?? (() => ({ status: 'missing' }))}
      onOpenLinkedSession={options.onOpenLinkedSession ?? (() => undefined)}
      connectionEpoch={connectionEpoch}
    />
  )
  const view = render(panel())
  return {
    view,
    requests,
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
    setConnectionEpoch: (epoch) => {
      connectionEpoch = epoch
      view.rerender(panel())
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
      { timing: 'every', selector: 'every_seconds', value: 60 },
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
        const interval = screen.getByLabelText<HTMLInputElement>('Interval in seconds')
        if (item.timing === 'every') {
          expect(interval.min).toBe('60')
          expect(interval.value).toBe('60')
        }
        fireEvent.change(interval, { target: { value: item.timing === 'every' ? '60' : '300' } })
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

  it('opens the original Session by its loaded title and rechecks membership at click time', async () => {
    let link: ReturnType<SchedulePanelProps['getLinkedSession']> = {
      status: 'available',
      title: 'Garden chat',
    }
    const getLinkedSession = vi.fn(() => link)
    const onOpenLinkedSession = vi.fn()
    mountPanel({ getLinkedSession, onOpenLinkedSession })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))

    const linkedSession = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Open original session: Garden chat',
    })
    expect(linkedSession.disabled).toBe(false)
    link = { status: 'archived' }
    fireEvent.click(linkedSession)
    expect(onOpenLinkedSession).not.toHaveBeenCalled()

    link = { status: 'available', title: 'Garden chat' }
    fireEvent.click(linkedSession)
    expect(onOpenLinkedSession).toHaveBeenCalledTimes(1)
    expect(onOpenLinkedSession).toHaveBeenCalledWith('session-original')
  })

  it('keeps the linked Session disabled and explains pending, failed, archived and missing metadata', async () => {
    const cases = [
      { link: { status: 'loading' } as const, message: 'Checking whether the original session is available' },
      {
        link: { status: 'error' } as const,
        message: 'Could not verify the original session in this workspace',
      },
      { link: { status: 'archived' } as const, message: 'The original session is archived' },
      {
        link: { status: 'missing' } as const,
        message: 'The original session is not available in this workspace',
      },
    ]
    for (const item of cases) {
      mountPanel({ getLinkedSession: () => item.link })
      fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Open original session: session-original' })
          .disabled,
      ).toBe(true)
      expect(screen.getByText(new RegExp(item.message, 'u'))).toBeDefined()
      cleanup()
    }
  })

  it('reloads catalog and selected delivery history after a reconnect without an invalidation event', async () => {
    const panel = mountPanel()
    await screen.findByRole('button', { name: /Water the plants/u })
    fireEvent.click(screen.getByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(1),
    )

    panel.setConnectionEpoch(1)
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.catalog')).toHaveLength(2),
    )
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(2),
    )
    expect(screen.getByRole('tab', { name: 'Delivery history' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByText('Water the plants').length).toBeGreaterThan(0)
  })

  it('cancels reconnect catalog and history reads when the panel unmounts', async () => {
    let catalogReads = 0
    const releaseReads: (() => void)[] = []
    const panel = mountPanel({
      resolve: (request) => {
        if (request.type === 'schedule.catalog') {
          catalogReads += 1
          if (catalogReads === 1) return { kind: 'schedule.catalog', items: [active, ended] }
        }
        if (request.type === 'schedule.catalog' || request.type === 'schedule.history')
          return new Promise<unknown>((resolve) => {
            releaseReads.push(() => resolve(defaultResponse(request, [active, ended])))
          })
        return defaultResponse(request, [active, ended])
      },
    })
    await screen.findByRole('button', { name: /Water the plants/u })
    fireEvent.click(screen.getByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(1),
    )

    panel.setConnectionEpoch(1)
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.catalog')).toHaveLength(2),
    )
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(2),
    )
    const reconnectCatalog = panel.requests.filter((request) => request.type === 'schedule.catalog').at(-1)
    const historyRequests = panel.requests.filter((request) => request.type === 'schedule.history')
    if (reconnectCatalog === undefined) throw new Error('The reconnect catalog request is missing.')
    panel.view.unmount()
    const cancelledIds = panel.requests.flatMap((request) =>
      request.type === 'feature.request.cancel' ? [request.payload.targetRequestId] : [],
    )
    expect(cancelledIds).toContain(reconnectCatalog.requestId)
    for (const request of historyRequests) expect(cancelledIds).toContain(request.requestId)
    for (const release of releaseReads) release()
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

  it('prevalidates the 60-second minimum, IANA zones, DST gaps, and cron grammar', async () => {
    const startSession = vi.fn(() => Promise.resolve('session-new'))
    mountPanel({ onStartScheduleSession: startSession })
    await screen.findByRole('button', { name: /Water the plants/u })
    clickCreateOpen()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Validation case' } })
    fireEvent.change(screen.getByLabelText('Reminder instruction'), { target: { value: 'Do a check.' } })

    chooseTiming('every')
    fireEvent.change(screen.getByLabelText('Interval in seconds'), { target: { value: '59' } })
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

  it('does not consume modified tab-navigation keys', async () => {
    mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    const ruleTab = screen.getByRole('tab', { name: 'Reminder' })
    const historyTab = screen.getByRole('tab', { name: 'Delivery history' })
    ruleTab.focus()

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
        const init: KeyboardEventInit = { key, bubbles: true, cancelable: true }
        if (modifier === 'altKey') init.altKey = true
        else if (modifier === 'ctrlKey') init.ctrlKey = true
        else if (modifier === 'metaKey') init.metaKey = true
        else init.shiftKey = true
        const event = new KeyboardEvent('keydown', init)
        ruleTab.dispatchEvent(event)

        expect(event.defaultPrevented).toBe(false)
        expect(ruleTab.getAttribute('aria-selected')).toBe('true')
        expect(historyTab.getAttribute('aria-selected')).toBe('false')
        expect(document.activeElement).toBe(ruleTab)
      }
    }
  })

  it('keeps delete in the detail action strip and confirms it from either tab', async () => {
    const panel = mountPanel({ items: [active] })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }))
    const menu = screen.getByRole('menu', { name: 'More task actions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    expect(screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })).toBeDefined()

    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    expect(screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Delete reminder' }))

    await waitFor(() =>
      expect(panel.requests.some((request) => request.type === 'schedule.delete')).toBe(true),
    )
    expect(panel.requests.find((request) => request.type === 'schedule.delete')).toMatchObject({
      payload: { sessionId: 'session-original', id: 'schedule-one' },
    })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Schedule details' })).toBeNull())
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
        change: { kind: 'weekly', weekdays: [2, 5] },
      },
    })
  })

  it('shows the save bar only for a dirty draft and rebases clean versus unsaved drafts on refresh', async () => {
    let catalogRecord: ScheduleCatalogEntry = active
    let catalogCalls = 0
    const panel = mountPanel({
      items: [active],
      resolve: (request) => {
        if (request.type !== 'schedule.catalog') return defaultResponse(request, [catalogRecord])
        catalogCalls += 1
        return { kind: 'schedule.catalog', items: [catalogRecord] }
      },
    })
    await screen.findByRole('button', { name: /Water the plants/u })
    fireEvent.click(screen.getByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByText('Unsaved changes')).toBeNull()

    const invalidation = (localSeq: number): FeatureHostEvent => ({
      type: 'feature.event',
      name: 'schedule.invalidated',
      identity: { backendInstanceId: 'backend-one', connectionGeneration: 1, stream: 'local', localSeq },
    })
    catalogRecord = { ...active, title: 'Updated remotely', prompt: 'Remote instruction.' }
    act(() => panel.emit(invalidation(1)))
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Updated remotely'),
    )
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reminder instruction').value).toBe(
      'Remote instruction.',
    )
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()

    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name'), { target: { value: 'Local draft' } })
    expect(screen.getByText('Unsaved changes')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDefined()

    catalogRecord = { ...catalogRecord, title: 'Latest remote title', prompt: 'Latest remote instruction.' }
    act(() => panel.emit(invalidation(2)))
    await waitFor(() => expect(catalogCalls).toBe(3))
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Local draft')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reminder instruction').value).toBe(
      'Remote instruction.',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const detail = screen.getByRole('complementary', { name: 'Schedule details' })
    expect(within(detail).getByRole('heading', { name: 'Latest remote title' })).toBeDefined()
    expect(within(detail).getByText('Latest remote instruction.')).toBeDefined()
  })

  it('locks all edit controls while the update request is in flight', async () => {
    let finishUpdate: ((value: unknown) => void) | undefined
    const update = new Promise<unknown>((resolve) => {
      finishUpdate = resolve
    })
    const panel = mountPanel({
      items: [active],
      resolve: (request) =>
        request.type === 'schedule.update' ? update : defaultResponse(request, [active]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(panel.requests.some((request) => request.type === 'schedule.update')).toBe(true),
    )

    const editorFields = document.querySelector<HTMLFieldSetElement>('.dsh-schedule-panel__editor-fields')
    expect(editorFields?.disabled).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Name').matches(':disabled')).toBe(true)
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reminder instruction').matches(':disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).matches(':disabled')).toBe(true)
    const request = panel.requests.find((item) => item.type === 'schedule.update')
    if (request === undefined) throw new Error('The update request is missing.')
    await act(async () => {
      finishUpdate?.(defaultResponse(request, [active]))
      await Promise.resolve()
    })
    await screen.findByRole('button', { name: 'Edit' })
  })

  it('keeps a selected task visible but disables deletion until the catalog returns it', async () => {
    let items: readonly ScheduleCatalogEntry[] = [active]
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.catalog'
          ? { kind: 'schedule.catalog', items }
          : defaultResponse(request, items),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))

    items = []
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }))
    expect(await screen.findByText(/missing from the current catalog/u)).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Water the plants' })).toBeDefined()
    expect(screen.queryByRole('button', { name: /Water the plants/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }))
    const deleteAction = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Delete' })
    expect(deleteAction.disabled).toBe(true)
    fireEvent.click(deleteAction)
    expect(panel.requests.some((request) => request.type === 'schedule.delete')).toBe(false)

    items = [active]
    fireEvent.click(screen.getByRole('button', { name: 'Refresh schedules' }))
    await waitFor(() => expect(screen.queryByText(/missing from the current catalog/u)).toBeNull())
    expect(screen.getByRole('button', { name: /Water the plants/u })).toBeDefined()
    expect(deleteAction.disabled).toBe(false)
  })

  it('keeps the edit draft after a conflict and retries against the refreshed record', async () => {
    let catalogRecord: ScheduleCatalogEntry = active
    let updateCount = 0
    const { requests } = mountPanel({
      items: [active],
      resolve: (request) => {
        if (request.type === 'schedule.catalog') return { kind: 'schedule.catalog', items: [catalogRecord] }
        if (request.type === 'schedule.update') {
          updateCount += 1
          if (updateCount === 1) {
            catalogRecord = { ...active, title: 'Changed elsewhere', prompt: 'Updated instruction.' }
            return {
              kind: 'schedule.updated',
              result: { id: active.id, updated: false, code: 'schedule_conflict' },
            }
          }
          return defaultResponse(request, [catalogRecord])
        }
        return defaultResponse(request, [catalogRecord])
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name'), { target: { value: 'My draft title' } })
    fireEvent.change(screen.getByLabelText<HTMLTextAreaElement>('Reminder instruction'), {
      target: { value: 'My draft instruction.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere')
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('My draft title')
    expect(screen.getByLabelText<HTMLTextAreaElement>('Reminder instruction').value).toBe(
      'My draft instruction.',
    )
    expect(screen.getAllByText('Changed elsewhere').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(updateCount).toBe(2))
    const updates = requests.filter((request) => request.type === 'schedule.update')
    expect(updates[1]).toMatchObject({
      payload: {
        expected: { title: 'Changed elsewhere', prompt: 'Updated instruction.' },
        title: 'My draft title',
        prompt: 'My draft instruction.',
      },
    })
  })

  it('does not apply an update result to a different task selected while the write is pending', async () => {
    let finishUpdate: ((value: unknown) => void) | undefined
    const update = new Promise<unknown>((resolve) => {
      finishUpdate = resolve
    })
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.update' ? update : defaultResponse(request, [active, ended]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText<HTMLInputElement>('Name'), { target: { value: 'Pending rename' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(panel.requests.some((request) => request.type === 'schedule.update')).toBe(true),
    )

    fireEvent.click(screen.getByRole('button', { name: /Old reminder/u }))
    expect(screen.getByRole('heading', { name: 'Old reminder' })).toBeDefined()
    const updateRequest = panel.requests.find((request) => request.type === 'schedule.update')
    if (updateRequest === undefined) throw new Error('The pending update request is missing.')
    act(() => finishUpdate?.(defaultResponse(updateRequest, [active])))

    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.catalog')).toHaveLength(2),
    )
    expect(screen.getByRole('heading', { name: 'Old reminder' })).toBeDefined()
    expect(screen.queryByText('Reminder updated.')).toBeNull()
  })

  it('does not close another task after a pending deletion settles', async () => {
    let finishDelete: ((value: unknown) => void) | undefined
    const deletion = new Promise<unknown>((resolve) => {
      finishDelete = resolve
    })
    const panel = mountPanel({
      resolve: (request) =>
        request.type === 'schedule.delete' ? deletion : defaultResponse(request, [active, ended]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete reminder' }))
    await waitFor(() =>
      expect(panel.requests.some((request) => request.type === 'schedule.delete')).toBe(true),
    )

    fireEvent.click(screen.getByRole('button', { name: /Old reminder/u }))
    const deleteRequest = panel.requests.find((request) => request.type === 'schedule.delete')
    if (deleteRequest === undefined) throw new Error('The pending delete request is missing.')
    act(() =>
      finishDelete?.({
        kind: 'schedule.deleted',
        result: { id: deleteRequest.payload.id, deleted: true },
      }),
    )

    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.catalog')).toHaveLength(2),
    )
    expect(screen.getByRole('heading', { name: 'Old reminder' })).toBeDefined()
  })

  it('retains delivery and retention metadata and requests older history with the returned cursor', async () => {
    const { requests } = mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))

    const history = await screen.findByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).getByText('Remind me to water the plants.')).toBeDefined()
    expect(within(history).getByText(/Some earlier delivery records/u)).toBeDefined()
    expect(within(history).queryByText(/Older delivery records were removed/u)).toBeNull()
    expect(within(history).queryByText('History is retained for 30 days, up to 500 deliveries.')).toBeNull()
    fireEvent.click(within(history).getByRole('button', { name: 'Load older deliveries' }))

    await waitFor(() => {
      const pages = requests.filter((request) => request.type === 'schedule.history')
      expect(pages).toHaveLength(2)
      expect(pages[1]).toMatchObject({ payload: { before: 'delivery-one', sessionId: 'session-original' } })
    })
    expect(within(history).queryByText(/Older delivery records were removed/u)).toBeNull()
    expect(
      within(history).queryByRole('button', { name: 'Show delivery history retention rules' }),
    ).toBeNull()
  })

  it('cancels and ignores a delivery page that settles after leaving the Records tab', async () => {
    let finishStalePage: ((value: unknown) => void) | undefined
    const stalePage = new Promise<unknown>((resolve) => {
      finishStalePage = resolve
    })
    let finishFreshPage: ((value: unknown) => void) | undefined
    const freshPage = new Promise<unknown>((resolve) => {
      finishFreshPage = resolve
    })
    let historyReads = 0
    const freshDelivery: ScheduleDeliveryRecord = {
      scheduledAt: '2026-10-03T09:00:00.000Z',
      deliveredAt: '2026-10-03T09:00:01.000Z',
      messageId: 'fresh-delivery',
      prompt: 'Fresh saved prompt.',
    }
    const panel = mountPanel({
      items: [active],
      resolve: (request) => {
        if (request.type !== 'schedule.history') return defaultResponse(request, [active])
        historyReads += 1
        if (historyReads === 1) return stalePage
        return freshPage
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(1),
    )
    const staleRequest = panel.requests.find((request) => request.type === 'schedule.history')
    if (staleRequest === undefined) throw new Error('The pending history request is missing.')

    fireEvent.click(screen.getByRole('tab', { name: 'Reminder' }))
    expect(
      panel.requests.some(
        (request) =>
          request.type === 'feature.request.cancel' &&
          request.payload.targetRequestId === staleRequest.requestId,
      ),
    ).toBe(true)
    await act(async () => {
      finishStalePage?.({
        kind: 'schedule.history',
        result: {
          id: active.id,
          records: [{ ...delivery, prompt: 'Stale saved prompt.' }],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
        },
      })
      await Promise.resolve()
    })
    expect(screen.queryByText('Stale saved prompt.')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    await waitFor(() =>
      expect(panel.requests.filter((request) => request.type === 'schedule.history')).toHaveLength(2),
    )
    const history = screen.getByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).getByRole('status').textContent).toBe('Loading delivery history…')
    await act(async () => {
      finishFreshPage?.({
        kind: 'schedule.history',
        result: {
          id: active.id,
          records: [freshDelivery],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
        },
      })
      await Promise.resolve()
    })
    expect(await within(history).findByText('Fresh saved prompt.')).toBeDefined()
    expect(screen.queryByText('Stale saved prompt.')).toBeNull()
    expect(historyReads).toBe(2)
  })

  it('retains loaded records after an expired cursor and reloads the newest page', async () => {
    let historyReads = 0
    const newestDelivery: ScheduleDeliveryRecord = {
      scheduledAt: '2026-10-02T09:00:00.000Z',
      deliveredAt: '2026-10-02T09:00:01.000Z',
      messageId: 'newest-delivery',
      prompt: 'Newest saved prompt.',
    }
    const panel = mountPanel({
      items: [active],
      resolve: (request) => {
        if (request.type !== 'schedule.history') return defaultResponse(request, [active])
        historyReads += 1
        if (request.payload.before !== undefined)
          return {
            kind: 'schedule.history',
            result: { id: active.id, code: 'delivery_cursor_not_found' },
          }
        return {
          kind: 'schedule.history',
          result: {
            id: active.id,
            records: historyReads === 1 ? [delivery] : [newestDelivery],
            earlierRecordsUnavailable: false,
            earlierRecordsPruned: false,
            ...(historyReads === 1 ? { nextBefore: 'delivery-one' } : {}),
          },
        }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    expect(await screen.findByText('Remind me to water the plants.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Load older deliveries' }))

    expect(await screen.findByText(/history page is no longer available/u)).toBeDefined()
    const history = screen.getByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).getByText('Remind me to water the plants.')).toBeDefined()
    const refresh = screen.getByRole('button', { name: 'Refresh delivery records' })
    fireEvent.click(refresh)
    expect(await screen.findByText('Newest saved prompt.')).toBeDefined()
    expect(screen.queryByText(/history page is no longer available/u)).toBeNull()
    expect(
      panel.requests
        .filter((request) => request.type === 'schedule.history')
        .map((request) => request.payload.before),
    ).toEqual([undefined, 'delivery-one', undefined])
  })

  it('shows pruning only after the final nonempty history page and discloses retention on demand', async () => {
    const earlierDelivery: ScheduleDeliveryRecord = {
      scheduledAt: '2026-09-30T09:00:00.000Z',
      deliveredAt: '2026-09-30T09:00:01.000Z',
      messageId: 'delivery-older',
      prompt: 'Earlier saved prompt.',
    }
    let historyPage = 0
    mountPanel({
      items: [active],
      resolve: (request) => {
        if (request.type !== 'schedule.history') return defaultResponse(request, [active])
        historyPage += 1
        return {
          kind: 'schedule.history',
          result: {
            id: active.id,
            records: historyPage === 1 ? [delivery] : [earlierDelivery],
            earlierRecordsUnavailable: false,
            earlierRecordsPruned: true,
            retention: { days: 14, records: 100 },
            ...(historyPage === 1 ? { nextBefore: 'delivery-one' } : {}),
          },
        }
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    const history = await screen.findByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).queryByText(/Older delivery records were removed/u)).toBeNull()
    fireEvent.click(within(history).getByRole('button', { name: 'Load older deliveries' }))
    await waitFor(() => expect(within(history).getByText('Earlier saved prompt.')).toBeDefined())

    expect(within(history).getByText(/Older delivery records were removed/u)).toBeDefined()
    const showRetention = within(history).getByRole('button', {
      name: 'Show delivery history retention rules',
    })
    expect(showRetention.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(showRetention)
    expect(
      within(history)
        .getByRole('button', { name: 'Hide delivery history retention rules' })
        .getAttribute('aria-expanded'),
    ).toBe('true')
    expect(within(history).getByText('History is retained for 14 days, up to 100 deliveries.')).toBeDefined()
  })

  it('shows saved occurrence time in a recurring rule zone without exposing receipt time or id', async () => {
    const occurrence = '2026-10-01T09:00:00.000Z'
    const recurring: ScheduleCatalogEntry = {
      id: 'schedule-recurring',
      kind: 'daily',
      title: 'Morning review',
      prompt: 'Review the day.',
      scheduledAt: occurrence,
      time: '02:00:00.000',
      timeZone: 'America/Los_Angeles',
      sessionId: 'session-original',
      status: 'active',
      lastDelivery: {
        scheduledAt: occurrence,
        deliveredAt: '2026-10-01T11:30:00.000Z',
        messageId: 'receipt-message-id',
      },
    }
    mountPanel({
      items: [recurring],
      resolve: (request) =>
        request.type === 'schedule.history'
          ? {
              kind: 'schedule.history',
              result: {
                id: recurring.id,
                records: [
                  {
                    scheduledAt: occurrence,
                    deliveredAt: '2026-10-01T11:30:00.000Z',
                    messageId: 'receipt-message-id',
                    prompt: 'Saved prompt.',
                  },
                ],
                earlierRecordsUnavailable: false,
                earlierRecordsPruned: false,
                retention: { days: 30, records: 200 },
              },
            }
          : defaultResponse(request, [recurring]),
    })
    fireEvent.click(await screen.findByRole('button', { name: /Morning review/u }))
    expect(screen.getByText('October 1 at 2:00 AM')).toBeDefined()
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))
    const history = await screen.findByRole('tabpanel', { name: 'Delivery history' })
    const time = within(history).getByRole('time')
    expect(time.getAttribute('datetime')).toBe(occurrence)
    expect(time.textContent).toBe('October 1 at 2:00 AM')
    expect(history.textContent).not.toContain('4:30 AM')
    expect(history.textContent).not.toContain('receipt-message-id')
    expect(within(history).getByText('Saved prompt.')).toBeDefined()
  })

  it('seeds timing edits from the committed occurrence in its stored zone', async () => {
    const recurring: ScheduleCatalogEntry = {
      id: 'schedule-zone-seed',
      kind: 'daily',
      title: 'Evening review',
      prompt: 'Review the day.',
      scheduledAt: '2026-10-01T02:00:00.000Z',
      time: '19:00:00.000',
      timeZone: 'America/Los_Angeles',
      sessionId: 'session-original',
      status: 'active',
    }
    mountPanel({ items: [recurring] })
    fireEvent.click(await screen.findByRole('button', { name: /Evening review/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

    chooseTiming('at')
    expect(screen.getByLabelText<HTMLInputElement>('Date').value).toBe('2026-09-30')
    expect(screen.getByLabelText<HTMLInputElement>('Time').value.startsWith('19:00')).toBe(true)
    expect(screen.getByLabelText<HTMLInputElement>('Time zone').value).toBe('America/Los_Angeles')

    chooseTiming('weekly')
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Wednesday' }).checked).toBe(true)

    chooseTiming('cron')
    expect(screen.getByLabelText<HTMLInputElement>('Cron expression').value).toBe('0 19 * * *')
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
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'More task actions' }))
    const deleteButton = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteButton.hasAttribute('disabled')).toBe(false)

    fireEvent.click(deleteButton)
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete reminder' }))

    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.delete')).toBe(true))
    expect(requests.find((request) => request.type === 'schedule.delete')).toMatchObject({
      payload: { sessionId: 'session-old', id: 'schedule-ended' },
    })
  })

  it('requires 60 seconds when editing a recurring interval and accepts the boundary', async () => {
    const { requests } = mountPanel({ items: [active] })
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    chooseTiming('every')

    const interval = screen.getByLabelText<HTMLInputElement>('Interval in seconds')
    expect(interval.min).toBe('60')
    expect(interval.value).toBe('60')
    const form = document.querySelector<HTMLFormElement>('.dsh-schedule-panel__editor')
    if (form === null) throw new Error('The schedule editor is missing.')

    fireEvent.change(interval, { target: { value: '59' } })
    fireEvent.submit(form)
    expect((await screen.findByRole('alert')).textContent).toContain('at least 60 whole seconds')
    expect(requests.some((request) => request.type === 'schedule.update')).toBe(false)

    fireEvent.change(interval, { target: { value: '60' } })
    fireEvent.submit(form)
    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.update')).toBe(true))
    expect(requests.find((request) => request.type === 'schedule.update')).toMatchObject({
      payload: { change: { kind: 'every', seconds: 60 } },
    })
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

  it('names a composition without the Schedule service and recovers once it answers', async () => {
    const unavailable = Object.assign(new Error('The DSH request schedule/catalog failed (HTTP 404).'), {
      code: 'CAPABILITY_UNAVAILABLE',
    })
    let catalogCalls = 0
    mountPanel({
      resolve: (request) => {
        if (request.type !== 'schedule.catalog') return defaultResponse(request, [active])
        catalogCalls += 1
        if (catalogCalls === 1) throw unavailable
        return { kind: 'schedule.catalog', items: [active] }
      },
    })
    expect(await screen.findByText('This DSH does not provide the schedule service.')).toBeDefined()
    expect(screen.queryByText('Could not load schedules.')).toBeNull()
    expect(screen.queryByText('0 of 0 schedules')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('.dsh-schedule-panel__new')?.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Water the plants')).toBeDefined()
    expect(screen.queryByText('This DSH does not provide the schedule service.')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('.dsh-schedule-panel__new')?.disabled).toBe(false)
  })

  it('keeps a code-less catalog failure on the transient load-failure notice', async () => {
    mountPanel({
      resolve: (request) => {
        if (request.type !== 'schedule.catalog') return defaultResponse(request, [active])
        throw new Error('temporary failure')
      },
    })
    expect(await screen.findByText('Could not load schedules.')).toBeDefined()
    expect(screen.queryByText('This DSH does not provide the schedule service.')).toBeNull()
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
