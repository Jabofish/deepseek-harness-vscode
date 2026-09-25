import { describe, expect, it, vi } from 'vitest'
import type { ScheduleCatalogEntry, ScheduleRepository, ScheduleRecord } from '@dsh-vscode/domain'

import { ScheduleUseCases } from './schedule-use-cases.js'

const record: ScheduleRecord = {
  id: 'schedule-1',
  kind: 'at',
  title: 'Review',
  prompt: '[redacted prompt]',
  scheduledAt: '2026-10-01T09:00:00.000Z',
}
const entry: ScheduleCatalogEntry = { ...record, sessionId: 'session-1', status: 'active' }

describe('ScheduleUseCases', () => {
  it('delegates every Host Schedule operation with the caller signal and original binding', async () => {
    const methods = {
      catalog: vi.fn(() => Promise.resolve([entry])),
      list: vi.fn(() => Promise.resolve([record])),
      history: vi.fn(() =>
        Promise.resolve({
          id: record.id,
          records: [],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
          retention: { days: 30, records: 200 },
        }),
      ),
      update: vi.fn(() => Promise.resolve({ id: record.id, updated: true, record })),
      delete: vi.fn(() => Promise.resolve({ id: record.id, deleted: true as const })),
    } satisfies ScheduleRepository
    const useCases = new ScheduleUseCases(methods)
    const signal = new AbortController().signal

    await expect(useCases.catalog(signal)).resolves.toEqual([entry])
    await expect(useCases.list('session-1', signal)).resolves.toEqual([record])
    await expect(
      useCases.history({ sessionId: 'session-1', id: record.id, limit: 20 }, signal),
    ).resolves.toMatchObject({
      id: record.id,
      records: [],
    })
    await expect(
      useCases.update(
        {
          sessionId: 'session-1',
          id: record.id,
          expected: record,
          title: 'Renamed',
        },
        signal,
      ),
    ).resolves.toMatchObject({ updated: true })
    await expect(useCases.delete('session-1', record.id, signal)).resolves.toEqual({
      id: record.id,
      deleted: true,
    })

    expect(methods.catalog).toHaveBeenCalledWith(signal)
    expect(methods.list).toHaveBeenCalledWith('session-1', signal)
    expect(methods.history).toHaveBeenCalledWith({ sessionId: 'session-1', id: record.id, limit: 20 }, signal)
    expect(methods.update).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        id: record.id,
        expected: record,
        title: 'Renamed',
      },
      signal,
    )
    expect(methods.delete).toHaveBeenCalledWith('session-1', record.id, signal)
  })

  it('propagates cancellation and repository failures without converting them into success', async () => {
    const error = new Error('cancelled')
    const repository = {
      catalog: vi.fn(() => Promise.reject(error)),
    } as unknown as ScheduleRepository
    await expect(new ScheduleUseCases(repository).catalog(new AbortController().signal)).rejects.toBe(error)
  })
})
