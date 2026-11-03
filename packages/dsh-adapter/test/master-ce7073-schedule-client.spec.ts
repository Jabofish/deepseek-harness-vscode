import { describe, expect, it, vi, type Mock } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import {
  MASTER_CE7073_COMMIT,
  MasterCe7073ScheduleClient,
} from '../src/versions/master-ce7073/schedule-client.js'
import { Rc172ScheduleRepository } from '../src/versions/rc172/schedule-repository.js'
import { masterScheduleCatalog } from './fixtures/master-ce7073-schedule.js'

const row = masterScheduleCatalog[0]
const create = {
  title: row.title,
  prompt: row.prompt,
  timing: { kind: 'after', after_seconds: 60 } as const,
  target: { kind: 'session', sessionId: 'session-1' } as const,
}
const edit = {
  id: row.id,
  action: 'update' as const,
  patch: { active: false },
  expectedUpdatedAt: row.updatedAt,
}
const history = {
  id: row.id,
  records: [row.lastDelivery],
  earlierRecordsUnavailable: false,
  earlierRecordsPruned: false,
  retention: { days: 30, records: 100 },
}
const operations = [
  {
    method: 'catalog',
    args: {},
    value: masterScheduleCatalog,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.catalog(s),
  },
  {
    method: 'list',
    args: { limit: 2, offset: 0 },
    value: { items: masterScheduleCatalog, shown: 2, total: 2, limit: 2, offset: 0 },
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.list({ limit: 2, offset: 0 }, s),
  },
  {
    method: 'view',
    args: { id: row.id },
    value: row,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.view({ id: row.id }, s),
  },
  {
    method: 'history',
    args: { id: row.id, limit: 1 },
    value: history,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.history({ id: row.id, limit: 1 }, s),
  },
  {
    method: 'create',
    args: create,
    value: row,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.create(create, s),
  },
  {
    method: 'edit',
    args: edit,
    value: row,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.edit(edit, s),
  },
  {
    method: 'run',
    args: { id: row.id },
    value: row,
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.run({ id: row.id }, s),
  },
  {
    method: 'deleteInactive',
    args: {},
    value: { deleted: 1 },
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.deleteInactive(s),
  },
  {
    method: 'deliveryLimits',
    args: {},
    value: { newSessionIntervalSeconds: 60 },
    call: (c: MasterCe7073ScheduleClient, s?: AbortSignal) => c.deliveryLimits(s),
  },
]

type RemoteHandler = (...args: Parameters<DshTransport['remoteRequest']>) => Promise<unknown>
function harness(result: unknown): {
  client: MasterCe7073ScheduleClient
  transport: DshTransport
  remoteRequest: Mock<RemoteHandler>
  close: Mock<() => Promise<void>>
} {
  const remoteRequest = vi
    .fn<(...args: Parameters<DshTransport['remoteRequest']>) => Promise<unknown>>()
    .mockResolvedValue(result)
  const close = vi.fn(() => Promise.resolve())
  const transport: DshTransport = {
    remoteRequest: async <TResponse>(...args: Parameters<DshTransport['remoteRequest']>) =>
      (await remoteRequest(...args)) as TResponse,
    request: () => Promise.reject(new Error('Unexpected ordinary RPC')),
    openEventStream: async function* () {
      yield await Promise.reject(new Error('Unexpected stream'))
    },
    close,
  }
  return {
    client: new MasterCe7073ScheduleClient(transport, MASTER_CE7073_COMMIT),
    transport,
    remoteRequest,
    close,
  }
}

describe('commit-scoped master Schedule Remote preparation', () => {
  it('rejects a shared version label, abbreviated hash and adjacent source identity', () => {
    const { transport } = harness({ ok: true, value: [] })
    for (const identity of ['0.2.2-alpha.2', 'ce7073', 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3'])
      expect(() => new MasterCe7073ScheduleClient(transport, identity)).toThrowError(
        expect.objectContaining({ code: 'DSH_INCOMPATIBLE' }),
      )
  })

  for (const operation of operations) {
    it(`calls ${operation.method} with the new wire and forwards cancellation`, async () => {
      const { client, remoteRequest } = harness({ ok: true, value: operation.value })
      const signal = new AbortController().signal
      const value = await operation.call(client, signal)
      expect(value).toBeDefined()
      expect(JSON.stringify(value)).not.toContain('/private/example')
      expect(remoteRequest).toHaveBeenCalledExactlyOnceWith(
        `schedule/${operation.method}`,
        operation.args,
        signal,
      )
    })

    it(`rejects malformed ${operation.method} replies without replay`, async () => {
      const { client, remoteRequest } = harness({ ok: true, value: null })
      await expect(operation.call(client)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR', retryable: false })
      expect(remoteRequest).toHaveBeenCalledTimes(1)
    })

    it(`does not dispatch an already cancelled ${operation.method}`, async () => {
      const { client, remoteRequest } = harness({ ok: true, value: operation.value })
      await expect(operation.call(client, AbortSignal.abort())).rejects.toMatchObject({
        code: 'REQUEST_CANCELLED',
      })
      expect(remoteRequest).not.toHaveBeenCalled()
    })

    it(`preserves timeout/disconnect errors for ${operation.method} without retry or closing shared transport`, async () => {
      const { client, remoteRequest, close } = harness(undefined)
      const error = new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'Request timed out.',
        retryable: true,
      })
      remoteRequest.mockRejectedValue(error)
      await expect(operation.call(client)).rejects.toBe(error)
      expect(remoteRequest).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
    })
  }

  it('releases an in-flight request through the transport abort signal', async () => {
    const { client, remoteRequest } = harness(undefined)
    let pending = 0
    remoteRequest.mockImplementation(
      (_method, _args, signal) =>
        new Promise((_resolve, reject) => {
          pending += 1
          signal!.addEventListener(
            'abort',
            () => {
              pending -= 1
              reject(new AppError({ code: 'REQUEST_CANCELLED', message: 'Cancelled', retryable: false }))
            },
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const request = client.run({ id: row.id }, controller.signal)
    expect(pending).toBe(1)
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    expect(pending).toBe(0)
    expect(remoteRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    'invalid_prompt',
    'invalid_selector',
    'invalid_rule',
    'invalid_time_zone',
    'not_future',
    'time_out_of_range',
    'frequency_too_high',
    'subagent_session',
  ])('retains the safe input refusal %s', async (code) => {
    const { client } = harness({
      ok: false,
      error: { code: 'schedule/input-invalid', message: '/private/example', details: { code } },
    })
    await expect(client.create(create)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      retryable: false,
      message: 'DSH rejected the Schedule input.',
      context: { scheduleReason: code },
    })
  })

  it('handles archived targets and rejects undeclared input failures', async () => {
    const { client, remoteRequest } = harness({
      ok: false,
      error: {
        code: 'schedule/target-archived',
        message: '/private/example',
        details: { sessionId: 'session-1' },
      },
    })
    await expect(client.run({ id: row.id })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      context: { scheduleReason: 'target-archived' },
    })
    remoteRequest.mockResolvedValue({
      ok: false,
      error: { code: 'schedule/input-invalid', details: { code: 'unknown' } },
    })
    await expect(client.create(create)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('preserves conflict, not-found and pending-execution as non-mutating business values', async () => {
    const { client, remoteRequest } = harness({ ok: true, value: { id: row.id, code: 'schedule_conflict' } })
    expect(await client.edit(edit)).toEqual({ id: row.id, code: 'schedule_conflict' })
    remoteRequest.mockResolvedValue({ ok: true, value: { id: row.id, code: 'schedule_not_found' } })
    expect(await client.view({ id: row.id })).toEqual({ id: row.id, code: 'schedule_not_found' })
    remoteRequest.mockResolvedValue({ ok: true, value: { id: row.id, code: 'schedule_execution_pending' } })
    expect(await client.run({ id: row.id })).toEqual({ id: row.id, code: 'schedule_execution_pending' })
  })

  it('correlates list filters/pages, history size/cursors, task ids and edit actions', async () => {
    const { client, remoteRequest } = harness({
      ok: true,
      value: { items: [row], shown: 1, total: 1, limit: 100, offset: 0 },
    })
    await expect(client.list({ active: false })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(client.list({ offset: 100 })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    remoteRequest.mockResolvedValue({ ok: true, value: { ...history, nextBefore: 'wrong-cursor' } })
    await expect(client.history({ id: row.id, limit: 1 })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    remoteRequest.mockResolvedValue({ ok: true, value: { ...row, id: 'other' } })
    await expect(client.view({ id: row.id })).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    remoteRequest.mockResolvedValue({ ok: true, value: { id: row.id, deleted: true } })
    await expect(client.edit(edit)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    expect(await client.edit({ id: row.id, action: 'delete', expectedUpdatedAt: null })).toEqual({
      id: row.id,
      deleted: true,
    })
    expect(remoteRequest).toHaveBeenLastCalledWith(
      'schedule/edit',
      { id: row.id, action: 'delete', expectedUpdatedAt: null },
      undefined,
    )
  })

  it('refuses malformed requests before sending and keeps the published Schedule mapper strict', async () => {
    const { client, remoteRequest, transport } = harness({ ok: true, value: masterScheduleCatalog })
    await expect(client.edit({ ...edit, patch: {} })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(remoteRequest).not.toHaveBeenCalled()
    await expect(new Rc172ScheduleRepository(transport).catalog()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})
