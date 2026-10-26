// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it.each([
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
  ] as const)(
    'serializes the $timing RC2 selector exactly and waits for catalog confirmation after turn end',
    async (item) => {
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
      await screen.findByText(/no matching reminder is confirmed yet/u)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create reminder' }).disabled).toBe(true)
      panel.view.unmount()
    },
  )

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

  it('retains delivery and retention metadata and requests older history with the returned cursor', async () => {
    const { requests } = mountPanel()
    fireEvent.click(await screen.findByRole('button', { name: /Water the plants/u }))
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery history' }))

    const history = await screen.findByRole('tabpanel', { name: 'Delivery history' })
    expect(within(history).getByText('Remind me to water the plants.')).toBeDefined()
    expect(within(history).getByText(/Some earlier delivery records/u)).toBeDefined()
    expect(within(history).queryByText(/Older delivery records have been cleared/u)).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm reminder deletion' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete reminder' }))

    await waitFor(() => expect(requests.some((request) => request.type === 'schedule.delete')).toBe(true))
    const deleteRequest = requests.find((request) => request.type === 'schedule.delete')
    expect(deleteRequest).toMatchObject({ payload: { sessionId: 'session-original', id: 'schedule-one' } })
    expect(await screen.findByText('No scheduled reminders yet.')).toBeDefined()
  })
})
