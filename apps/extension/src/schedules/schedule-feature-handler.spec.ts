import { describe, expect, it, vi } from 'vitest'
import type {
  ScheduleCatalogEntry,
  ScheduleHistoryResult,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleUpdateResult,
} from '@dsh-vscode/domain'
import { ScheduleUseCases } from '@dsh-vscode/application'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'

import { handleScheduleFeatureRequest, type ScheduleFeatureRequest } from './schedule-feature-handler.js'

const record: ScheduleRecord = {
  id: 'schedule-1',
  kind: 'at',
  title: 'Review',
  prompt: '[redacted prompt]',
  scheduledAt: '2026-10-01T09:00:00.000Z',
}
const entry: ScheduleCatalogEntry = { ...record, sessionId: 'session-1', status: 'active' }
const history: ScheduleHistoryResult = {
  id: record.id,
  records: [],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
  retention: { days: 30, records: 200 },
}
const updated: ScheduleUpdateResult = { id: record.id, updated: true, record }

function repository(): {
  readonly useCases: ScheduleUseCases
  readonly methods: {
    readonly catalog: ReturnType<typeof vi.fn>
    readonly list: ReturnType<typeof vi.fn>
    readonly history: ReturnType<typeof vi.fn>
    readonly update: ReturnType<typeof vi.fn>
    readonly delete: ReturnType<typeof vi.fn>
  }
} {
  const methods = {
    catalog: vi.fn(() => Promise.resolve([entry])),
    list: vi.fn(() => Promise.resolve([record])),
    history: vi.fn(() => Promise.resolve(history)),
    update: vi.fn(() => Promise.resolve(updated)),
    delete: vi.fn(() => Promise.resolve({ id: record.id, deleted: true as const })),
  }
  const port: ScheduleRepository = methods
  return { useCases: new ScheduleUseCases(port), methods }
}

function request(type: ScheduleFeatureRequest['type'], payload: unknown): ScheduleFeatureRequest {
  return { type, requestId: `request-${type}`, payload } as ScheduleFeatureRequest
}

describe('Schedule feature handler', () => {
  it('routes catalog, session list, history, update, and delete with the host cancellation signal', async () => {
    const { useCases, methods } = repository()
    const signal = new AbortController().signal
    const requests: readonly ScheduleFeatureRequest[] = [
      request('schedule.catalog', {}),
      request('schedule.list', { sessionId: 'session-1' }),
      request('schedule.history', { sessionId: 'session-1', id: 'schedule-1', limit: 20 }),
      request('schedule.update', {
        sessionId: 'session-1',
        id: 'schedule-1',
        expected: record,
        title: 'Updated',
      }),
      request('schedule.delete', { sessionId: 'session-1', id: 'schedule-1' }),
    ]
    const responses = await Promise.all(
      requests.map((value) => handleScheduleFeatureRequest(value, useCases, signal)),
    )

    expect(responses).toEqual([
      { kind: 'schedule.catalog', items: [entry] },
      { kind: 'schedule.records', items: [record] },
      { kind: 'schedule.history', result: history },
      { kind: 'schedule.updated', result: updated },
      { kind: 'schedule.deleted', result: { id: 'schedule-1', deleted: true } },
    ])
    expect(methods.catalog).toHaveBeenCalledWith(signal)
    expect(methods.list).toHaveBeenCalledWith('session-1', signal)
    expect(methods.history).toHaveBeenCalledWith(
      { sessionId: 'session-1', id: 'schedule-1', limit: 20 },
      signal,
    )
    expect(methods.update).toHaveBeenCalledWith(
      { sessionId: 'session-1', id: 'schedule-1', expected: record, title: 'Updated' },
      signal,
    )
    expect(methods.delete).toHaveBeenCalledWith('session-1', 'schedule-1', signal)
  })

  it('propagates repository errors so the feature router can report a retryable failure', async () => {
    const error = new Error('cancelled')
    const { useCases, methods } = repository()
    methods.catalog.mockRejectedValueOnce(error)

    await expect(
      handleScheduleFeatureRequest(
        request('schedule.catalog', {}) as Extract<FeatureRequest, { type: 'schedule.catalog' }>,
        useCases,
        new AbortController().signal,
      ),
    ).rejects.toBe(error)
  })
})
