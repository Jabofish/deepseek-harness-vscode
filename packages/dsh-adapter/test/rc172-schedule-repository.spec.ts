import { describe, expect, it } from 'vitest'
import type { ScheduleRecord } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc172ScheduleRepository } from '../src/versions/rc172/schedule-repository.js'

interface RemoteCall {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal | undefined
}

function recordingTransport(responses: readonly unknown[]): {
  readonly transport: DshTransport
  readonly calls: RemoteCall[]
} {
  const pending = [...responses]
  const calls: RemoteCall[] = []
  const transport: DshTransport = {
    request: <TResponse>() => Promise.reject<TResponse>(new Error('Schedule tests issue no ordinary RPC')),
    remoteRequest: <TResponse>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<TResponse> =>
      Promise.resolve().then(() => {
        calls.push({ endpoint, args, signal })
        signal?.throwIfAborted()
        if (pending.length === 0) throw new Error('unexpected Schedule Remote request')
        return pending.shift() as TResponse
      }),
    openEventStream: async function* () {
      /* Schedule queries do not open their own streams. */
    },
    close: () => Promise.resolve(),
  }
  return { transport, calls }
}

const at = {
  id: 'schedule-at',
  kind: 'at',
  title: 'One time',
  prompt: '[redacted prompt]',
  scheduledAt: '2026-10-02T09:00:00.000Z',
} as const satisfies ScheduleRecord
const after = {
  ...at,
  id: 'schedule-after',
  kind: 'after',
  afterSeconds: 120,
} as const satisfies ScheduleRecord
const every = {
  ...at,
  id: 'schedule-every',
  kind: 'every',
  everySeconds: 900,
} as const satisfies ScheduleRecord
const daily = {
  ...at,
  id: 'schedule-daily',
  kind: 'daily',
  time: '09:00:00',
  timeZone: 'UTC',
} as const satisfies ScheduleRecord
const weekly = {
  ...at,
  id: 'schedule-weekly',
  kind: 'weekly',
  time: '09:00:00',
  timeZone: 'Europe/Paris',
  weekdays: [1, 3, 5],
} as const satisfies ScheduleRecord
const cron = {
  ...at,
  id: 'schedule-cron',
  kind: 'cron',
  expression: '0 9 * * 1',
  timeZone: 'UTC',
} as const satisfies ScheduleRecord

describe('DSH 0.1.7-rc.2 Schedule Remote contract', () => {
  it('projects all catalog record variants, original bindings, and delivery receipts', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: [
          { ...at, sessionId: 'session-1', status: 'active' },
          { ...after, sessionId: 'session-1', status: 'active' },
          { ...every, sessionId: 'session-2', status: 'active' },
          { ...daily, sessionId: 'session-2', status: 'active' },
          { ...weekly, sessionId: 'session-3', status: 'inactive' },
          {
            ...cron,
            sessionId: 'session-4',
            status: 'inactive',
            lastDelivery: {
              scheduledAt: '2026-10-01T09:00:00.000Z',
              deliveredAt: '2026-10-01T09:00:01.000Z',
              messageId: 'message-1',
            },
          },
        ],
      },
    ])
    const signal = new AbortController().signal

    await expect(new Rc172ScheduleRepository(transport).catalog(signal)).resolves.toMatchObject([
      { id: 'schedule-at', kind: 'at', sessionId: 'session-1', status: 'active' },
      { id: 'schedule-after', kind: 'after', afterSeconds: 120 },
      { id: 'schedule-every', kind: 'every', everySeconds: 900 },
      { id: 'schedule-daily', kind: 'daily', timeZone: 'UTC' },
      { id: 'schedule-weekly', kind: 'weekly', weekdays: [1, 3, 5], status: 'inactive' },
      { id: 'schedule-cron', kind: 'cron', lastDelivery: { messageId: 'message-1' } },
    ])
    expect(calls).toEqual([{ endpoint: 'schedule/catalog', args: {}, signal }])
  })

  it('reads active Session records without a Host catalog binding', async () => {
    const { transport, calls } = recordingTransport([{ ok: true, value: [every] }])
    const signal = new AbortController().signal

    await expect(new Rc172ScheduleRepository(transport).list('session-7', signal)).resolves.toEqual([every])
    expect(calls).toEqual([{ endpoint: 'schedule/list', args: { sessionId: 'session-7' }, signal }])
  })

  it('loads bounded history pages with exclusive cursors and preserves retention facts', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          id: 'schedule-weekly',
          records: [
            {
              scheduledAt: '2026-10-01T09:00:00.000Z',
              deliveredAt: '2026-10-01T09:00:01.000Z',
              messageId: 'message-9',
              prompt: '[redacted saved prompt]',
            },
          ],
          earlierRecordsUnavailable: true,
          earlierRecordsPruned: false,
          retention: { days: 30, records: 500 },
          nextBefore: 'message-9',
        },
      },
    ])
    const signal = new AbortController().signal

    await expect(
      new Rc172ScheduleRepository(transport).history(
        { sessionId: 'session-3', id: 'schedule-weekly', limit: 20, before: 'message-10' },
        signal,
      ),
    ).resolves.toMatchObject({
      id: 'schedule-weekly',
      earlierRecordsUnavailable: true,
      retention: { days: 30, records: 500 },
      nextBefore: 'message-9',
    })
    expect(calls).toEqual([
      {
        endpoint: 'schedule/history',
        args: { sessionId: 'session-3', id: 'schedule-weekly', limit: 20, before: 'message-10' },
        signal,
      },
    ])
  })

  it('maps an update to the complete expected record and the exact rc.2 timing selector', async () => {
    const updated = { ...weekly, time: '10:30:00', weekdays: [2, 4] }
    const request = {
      sessionId: 'session-3',
      id: 'schedule-weekly',
      expected: weekly,
      title: 'Updated title',
      prompt: '[redacted replacement prompt]',
      change: {
        kind: 'weekly' as const,
        time: '10:30:00',
        timeZone: 'Europe/Paris',
        weekdays: [2, 4],
      },
    }
    const { transport, calls } = recordingTransport([
      { ok: true, value: { id: request.id, updated: true, record: updated } },
    ])
    const signal = new AbortController().signal

    await expect(new Rc172ScheduleRepository(transport).update(request, signal)).resolves.toEqual({
      id: request.id,
      updated: true,
      record: updated,
    })
    expect(calls).toEqual([
      {
        endpoint: 'schedule/update',
        args: {
          sessionId: 'session-3',
          id: 'schedule-weekly',
          expected: weekly,
          title: 'Updated title',
          prompt: '[redacted replacement prompt]',
          change: {
            kind: 'weekly',
            weekly: { time: '10:30:00', time_zone: 'Europe/Paris', weekdays: [2, 4] },
          },
        },
        signal,
      },
    ])
  })

  it('translates local-time input and every-seconds selectors without inventing create', async () => {
    const atTransport = recordingTransport([
      { ok: true, value: { id: 'schedule-at', updated: true, record: at } },
    ])
    const atRepository = new Rc172ScheduleRepository(atTransport.transport)
    await atRepository.update({
      sessionId: 'session-1',
      id: 'schedule-at',
      expected: at,
      change: { kind: 'at', at: { date: '2026-10-03', time: '10:15:00', timeZone: 'Europe/Paris' } },
    })
    expect(atTransport.calls[0]?.args).toMatchObject({
      change: { kind: 'at', at: { date: '2026-10-03', time: '10:15:00', time_zone: 'Europe/Paris' } },
    })

    const everyTransport = recordingTransport([
      { ok: true, value: { id: 'schedule-every', updated: true, record: every } },
    ])
    await new Rc172ScheduleRepository(everyTransport.transport).update({
      sessionId: 'session-2',
      id: 'schedule-every',
      expected: every,
      change: { kind: 'every', seconds: 1_800 },
    })
    expect(everyTransport.calls[0]?.args).toMatchObject({
      change: { kind: 'every', every_seconds: 1_800 },
    })
    expect([...atTransport.calls, ...everyTransport.calls].map(({ endpoint }) => endpoint)).not.toContain(
      'schedule/create',
    )
  })

  it('maps daily and cron timing changes with explicit IANA zones', async () => {
    const dailyTransport = recordingTransport([
      { ok: true, value: { id: 'schedule-daily', updated: true, record: daily } },
    ])
    await new Rc172ScheduleRepository(dailyTransport.transport).update({
      sessionId: 'session-daily',
      id: daily.id,
      expected: daily,
      change: { kind: 'daily', time: '08:45:00', timeZone: 'Asia/Shanghai' },
    })
    expect(dailyTransport.calls[0]?.args).toMatchObject({
      change: { kind: 'daily', daily: { time: '08:45:00', time_zone: 'Asia/Shanghai' } },
    })

    const cronTransport = recordingTransport([
      { ok: true, value: { id: 'schedule-cron', updated: true, record: cron } },
    ])
    await new Rc172ScheduleRepository(cronTransport.transport).update({
      sessionId: 'session-cron',
      id: cron.id,
      expected: cron,
      change: { kind: 'cron', expression: '30 8 * * 1-5', timeZone: 'America/New_York' },
    })
    expect(cronTransport.calls[0]?.args).toMatchObject({
      change: { kind: 'cron', cron: { expression: '30 8 * * 1-5', time_zone: 'America/New_York' } },
    })
  })

  it("deletes through the task's original Session binding", async () => {
    const { transport, calls } = recordingTransport([
      { ok: true, value: { id: 'schedule-cron', deleted: true } },
    ])
    const signal = new AbortController().signal

    await expect(
      new Rc172ScheduleRepository(transport).delete('session-4', 'schedule-cron', signal),
    ).resolves.toEqual({
      id: 'schedule-cron',
      deleted: true,
    })
    expect(calls).toEqual([
      { endpoint: 'schedule/delete', args: { sessionId: 'session-4', id: 'schedule-cron' }, signal },
    ])
  })

  it('preserves non-mutating misses and validates remote result ownership', async () => {
    const { transport } = recordingTransport([
      { ok: true, value: { id: 'schedule-1', updated: false, record: { ...at, id: 'schedule-1' } } },
      { ok: true, value: { id: 'schedule-other', deleted: true } },
      { ok: true, value: { id: 'schedule-1', code: 'delivery_cursor_not_found' } },
    ])
    const repository = new Rc172ScheduleRepository(transport)

    await expect(
      repository.update({
        sessionId: 'session-1',
        id: 'schedule-1',
        expected: { ...at, id: 'schedule-1' },
        title: 'x',
      }),
    ).resolves.toEqual({
      id: 'schedule-1',
      updated: false,
      record: { ...at, id: 'schedule-1' },
    })
    await expect(repository.delete('session-1', 'schedule-1')).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    await expect(
      repository.history({ sessionId: 'session-1', id: 'schedule-1', limit: 20 }),
    ).resolves.toEqual({
      id: 'schedule-1',
      code: 'delivery_cursor_not_found',
    })
  })

  it('rejects invalid identifiers before transport and forwards cancellation', async () => {
    const { transport, calls } = recordingTransport([{ ok: true, value: [] }])
    const repository = new Rc172ScheduleRepository(transport)

    await expect(repository.list(' ')).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(calls).toEqual([])

    const controller = new AbortController()
    controller.abort()
    await expect(repository.catalog(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it('rejects malformed variants, history pages, and update records without exposing response data', async () => {
    const { transport } = recordingTransport([
      { ok: true, value: [{ ...at, kind: 'weekly' }] },
      {
        ok: true,
        value: {
          id: 'schedule-1',
          records: [],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
          retention: { days: -1, records: 20 },
        },
      },
      { ok: true, value: { id: 'schedule-1', updated: true, record: { ...at, id: 'schedule-other' } } },
    ])
    const repository = new Rc172ScheduleRepository(transport)

    const catalogError = await repository.catalog().catch((error: unknown) => error)
    expect(catalogError).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(catalogError).toHaveProperty('message', 'DSH returned a malformed rc172 Schedule catalog entry.')
    const historyError = await repository
      .history({ sessionId: 'session-1', id: 'schedule-1', limit: 20 })
      .catch((error: unknown) => error)
    expect(historyError).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(historyError).toHaveProperty('message', 'DSH returned a malformed rc172 Schedule history page.')
    const updateError = await repository
      .update({
        sessionId: 'session-1',
        id: 'schedule-1',
        expected: { ...at, id: 'schedule-1' },
        title: 'New',
      })
      .catch((error: unknown) => error)
    expect(updateError).toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(updateError).toHaveProperty('message', 'DSH returned a malformed rc172 Schedule update result.')
  })

  it('maps a failed Remote envelope to a safe AppError without copying DSH details', async () => {
    const { transport } = recordingTransport([
      {
        ok: false,
        error: {
          code: 'invalid-time-zone',
          message: 'private upstream diagnostic',
          details: { prompt: '[redacted]' },
        },
      },
    ])

    const error = await new Rc172ScheduleRepository(transport).catalog().catch((reason: unknown) => reason)
    expect(error).toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { rpcCode: 'invalid-time-zone' },
    })
    expect(error).toHaveProperty(
      'message',
      'The DSH time zone is invalid. Details: private upstream diagnostic',
    )
    expect((error as Error).message).not.toContain('sensitive prompt')
  })
})
