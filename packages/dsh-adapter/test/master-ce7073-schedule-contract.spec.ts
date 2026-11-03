import { describe, expect, it } from 'vitest'
import {
  parseMasterScheduleCatalog,
  parseMasterScheduleCreate,
  parseMasterScheduleCreateRequest,
  parseMasterScheduleDeleteInactive,
  parseMasterScheduleDeliveryLimits,
  parseMasterScheduleEdit,
  parseMasterScheduleEditRequest,
  parseMasterScheduleHistory,
  parseMasterScheduleHistoryRequest,
  parseMasterScheduleIdRequest,
  parseMasterScheduleList,
  parseMasterScheduleListRequest,
  parseMasterScheduleRun,
  parseMasterScheduleView,
} from '../src/versions/master-ce7073/schedule-contract.js'
import { masterScheduleCatalog } from './fixtures/master-ce7073-schedule.js'

describe('unreleased master Schedule catalogue preparation', () => {
  it('accepts Host-wide targets, paused tasks and RRULE while dropping target creation paths', () => {
    const result = parseMasterScheduleCatalog(masterScheduleCatalog)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      kind: 'daily',
      status: 'active',
      target: { kind: 'session', sessionId: 'session-1' },
      lastDelivery: { targetSessionId: 'session-1' },
    })
    expect(result[1]).toMatchObject({
      kind: 'rrule',
      status: 'paused',
      target: { kind: 'new', create: { agentPreset: 'standard' } },
    })
    expect(JSON.stringify(result)).not.toContain('/private/example')
  })

  it('accepts the reserved target of a new-once task and its ended status', () => {
    const [sample] = masterScheduleCatalog
    expect(
      parseMasterScheduleCatalog([
        { ...sample, status: 'ended', target: { kind: 'new_once', sessionId: 'reserved-1', create: {} } },
      ])[0],
    ).toMatchObject({ status: 'ended', target: { kind: 'new_once', sessionId: 'reserved-1' } })
  })

  it('rejects old Session-bound rows and malformed new records instead of guessing ownership', () => {
    const [sample] = masterScheduleCatalog
    expect(() => parseMasterScheduleCatalog([{ ...sample, status: 'inactive', target: undefined }])).toThrow()
    expect(() => parseMasterScheduleCatalog([{ ...sample, target: { kind: 'session' } }])).toThrow()
    expect(() => parseMasterScheduleCatalog([{ ...sample, kind: 'unknown' }])).toThrow()
    expect(() => parseMasterScheduleCatalog([{ ...sample, involvedSessionIds: [''] }])).toThrow()
  })

  it('validates paged Host-wide lists without treating an inconsistent page as complete', () => {
    const page = { items: masterScheduleCatalog, shown: 2, total: 3, limit: 2, offset: 0 }
    expect(parseMasterScheduleList(page)).toMatchObject({ shown: 2, total: 3 })
    expect(() => parseMasterScheduleList({ ...page, shown: 1 })).toThrow()
    expect(() => parseMasterScheduleList({ ...page, total: 1 })).toThrow()
    expect(() => parseMasterScheduleList({ ...page, offset: 2 })).toThrow()
  })

  it('retains history receipts and handles missing task and cursor without confusing identities', () => {
    const history = {
      id: 'schedule-daily',
      records: [{ ...masterScheduleCatalog[0].lastDelivery, prompt: 'A delivered instruction' }],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      retention: { days: 30, records: 100 },
    }
    expect(parseMasterScheduleHistory(history, 'schedule-daily')).toMatchObject({
      records: [{ targetSessionId: 'session-1', prompt: 'A delivered instruction' }],
    })
    expect(
      parseMasterScheduleHistory(
        { id: 'schedule-daily', code: 'delivery_cursor_not_found' },
        'schedule-daily',
      ),
    ).toMatchObject({ code: 'delivery_cursor_not_found' })
    expect(() => parseMasterScheduleHistory(history, 'other-task')).toThrow('identity mismatch')
  })

  it('distinguishes changed tasks, deletion, conflict, pending execution and not-found', () => {
    expect(parseMasterScheduleEdit(masterScheduleCatalog[0], 'schedule-daily')).toMatchObject({
      status: 'active',
    })
    expect(parseMasterScheduleEdit({ id: 'schedule-daily', deleted: true }, 'schedule-daily')).toMatchObject({
      deleted: true,
    })
    expect(
      parseMasterScheduleEdit({ id: 'schedule-daily', code: 'schedule_conflict' }, 'schedule-daily'),
    ).toMatchObject({ code: 'schedule_conflict' })
    expect(
      parseMasterScheduleRun({ id: 'schedule-daily', code: 'schedule_execution_pending' }, 'schedule-daily'),
    ).toMatchObject({ code: 'schedule_execution_pending' })
    expect(
      parseMasterScheduleView({ id: 'schedule-daily', code: 'schedule_not_found' }, 'schedule-daily'),
    ).toMatchObject({ code: 'schedule_not_found' })
    expect(() => parseMasterScheduleEdit({ id: 'other', deleted: true }, 'schedule-daily')).toThrow(
      'identity mismatch',
    )
    expect(() =>
      parseMasterScheduleEdit({ id: 'schedule-daily', deleted: false }, 'schedule-daily'),
    ).toThrow()
  })
  it('prepares typed creation and editing requests while retaining explicit revisions', () => {
    const create = {
      title: 'Review changes',
      prompt: 'Review the project',
      timing: { kind: 'cron', cron: { expression: '30 9 * * 1', time_zone: 'UTC' } },
      target: { kind: 'session', sessionId: 'session-1' },
    }
    expect(parseMasterScheduleCreateRequest(create)).toEqual(create)
    const update = {
      id: 'schedule-daily',
      action: 'update',
      patch: { active: false },
      expectedUpdatedAt: null,
    }
    expect(parseMasterScheduleEditRequest(update)).toEqual(update)
    expect(parseMasterScheduleEditRequest({ id: 'schedule-daily', action: 'delete' })).toEqual({
      id: 'schedule-daily',
      action: 'delete',
    })
    expect(() => parseMasterScheduleEditRequest({ ...update, patch: {} })).toThrow()
    expect(() => parseMasterScheduleEditRequest({ ...update, sessionId: 'session-1' })).toThrow()
    expect(() =>
      parseMasterScheduleCreateRequest({ ...create, timing: { kind: 'every', every_seconds: 1 } }),
    ).toThrow()
  })

  it('validates Host-wide read request shapes and bounds', () => {
    expect(parseMasterScheduleListRequest({ active: false, limit: 100, offset: 0 })).toEqual({
      active: false,
      limit: 100,
      offset: 0,
    })
    expect(
      parseMasterScheduleHistoryRequest({ id: 'schedule-daily', limit: 10, before: 'message-1' }),
    ).toMatchObject({ before: 'message-1' })
    expect(parseMasterScheduleIdRequest({ id: 'schedule-daily' })).toEqual({ id: 'schedule-daily' })
    expect(() => parseMasterScheduleHistoryRequest({ id: 'schedule-daily', limit: 101 })).toThrow()
    expect(() =>
      parseMasterScheduleHistoryRequest({ id: 'schedule-daily', sessionId: 'session-1', limit: 10 }),
    ).toThrow()
  })

  it('validates creation, bulk deletion and delivery-limit responses', () => {
    expect(parseMasterScheduleCreate(masterScheduleCatalog[0])).toMatchObject({ id: 'schedule-daily' })
    expect(parseMasterScheduleDeleteInactive({ deleted: 2 })).toEqual({ deleted: 2 })
    expect(parseMasterScheduleDeliveryLimits({ newSessionIntervalSeconds: 60 })).toEqual({
      newSessionIntervalSeconds: 60,
    })
    expect(() => parseMasterScheduleDeleteInactive({ deleted: -1 })).toThrow()
    expect(() => parseMasterScheduleDeliveryLimits({ newSessionIntervalSeconds: '60' })).toThrow()
    expect(() => parseMasterScheduleDeliveryLimits({ newSessionIntervalSeconds: 0 })).toThrow()
  })

  it('rejects impossible dates, duplicate weekdays and sub-minute stored recurrences', () => {
    const sample = masterScheduleCatalog[0]
    for (const extra of [
      { scheduledAt: '2026-02-30T09:00:00.000Z' },
      { kind: 'weekly', weekdays: [1, 1] },
      { kind: 'every', everySeconds: 59 },
      { id: '   ' },
    ])
      expect(() => parseMasterScheduleCatalog([{ ...sample, ...extra }])).toThrow()
  })
})
