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
  everySeconds: 60,
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
      { id: 'schedule-every', kind: 'every', everySeconds: 60 },
      { id: 'schedule-daily', kind: 'daily', timeZone: 'UTC' },
      { id: 'schedule-weekly', kind: 'weekly', weekdays: [1, 3, 5], status: 'inactive' },
      { id: 'schedule-cron', kind: 'cron', lastDelivery: { messageId: 'message-1' } },
    ])
    expect(calls).toEqual([{ endpoint: 'schedule/catalog', args: {}, signal }])
  })

  it('enforces the RC2 one-minute minimum when reading and writing recurring rules', async () => {
    const invalidCatalog = recordingTransport([{ ok: true, value: [{ ...every, everySeconds: 59 }] }])
    await expect(new Rc172ScheduleRepository(invalidCatalog.transport).catalog()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })

    const invalidChange = recordingTransport([])
    await expect(
      new Rc172ScheduleRepository(invalidChange.transport).update({
        sessionId: 'session-1',
        id: every.id,
        expected: every,
        change: { kind: 'every', seconds: 59 },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(invalidChange.calls).toEqual([])

    const invalidExpected = recordingTransport([])
    await expect(
      new Rc172ScheduleRepository(invalidExpected.transport).update({
        sessionId: 'session-1',
        id: every.id,
        expected: { ...every, everySeconds: 59 },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(invalidExpected.calls).toEqual([])

    const invalidReceipt = recordingTransport([
      { ok: true, value: { id: every.id, updated: true, record: { ...every, everySeconds: 59 } } },
    ])
    await expect(
      new Rc172ScheduleRepository(invalidReceipt.transport).update({
        sessionId: 'session-1',
        id: every.id,
        expected: every,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
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
})
