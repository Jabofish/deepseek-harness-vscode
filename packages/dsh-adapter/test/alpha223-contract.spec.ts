import { describe, expect, it, vi, type Mock } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Alpha223ScheduleRepository } from '../src/versions/alpha223/schedule-repository.js'
import { normalizeAlpha223ControlFrame } from '../src/versions/alpha223/session-control.js'
import { normalizeAlpha171ControlFrame } from '../src/versions/alpha171/session-control.js'
import { alpha223Task, alpha223Projection } from './fixtures/alpha223-contract.js'
import { Alpha223VersionAdapter } from '../src/versions/alpha223/adapter.js'
import { endpoint, transportOptions } from './support/contract-harness.js'
type Handler = (...args: Parameters<DshTransport['remoteRequest']>) => Promise<unknown>
function harness(value: unknown): { repository: Alpha223ScheduleRepository; request: Mock<Handler> } {
  const request = vi.fn<Handler>().mockResolvedValue({ ok: true, value })
  const transport: DshTransport = {
    remoteRequest: async <T>(...args: Parameters<DshTransport['remoteRequest']>) =>
      (await request(...args)) as T,
    request: () => Promise.reject(new Error('Unexpected ordinary RPC')),
    openEventStream: async function* () {
      yield await Promise.reject(new Error('Unexpected stream'))
    },
    close: () => Promise.resolve(),
  }
  return { repository: new Alpha223ScheduleRepository(transport), request }
}
describe('published alpha223 changed contracts', () => {
  it('rejects a semantically malformed later projection before publishing earlier changes', () => {
    class Adapter extends Alpha223VersionAdapter {
      public normalize(value: unknown): readonly unknown[] | undefined {
        return this.createTransportOptions(endpoint).normalizeControlFrame?.(value)
      }
    }
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(adapter.normalize(alpha223Projection)).toHaveLength(3)
    expect(() =>
      adapter.normalize({
        ...alpha223Projection,
        changes: [
          { key: 'modelSelection', val: { lastUsed: null, next: null } },
          { key: 'todos', val: [{ content: 'Invalid later item', status: 'unknown' }] },
        ],
      }),
    ).toThrow('malformed todo')
  })
  it('validates a complete per-event batch, keeping equal-sequence keys and deriving Inbox before its watermark', () => {
    expect(normalizeAlpha223ControlFrame(alpha223Projection)).toEqual([
      {
        type: 'session/projection',
        sessionId: 's',
        seq: 5,
        key: 'todos',
        value: alpha223Projection.changes[0].val,
      },
      { type: 'session/queue', sessionId: 's', asOfSequence: 5, items: [] },
      {
        type: 'session/projection',
        sessionId: 's',
        seq: 5,
        key: 'inbox',
        value: alpha223Projection.changes[1].val,
      },
    ])
    expect(normalizeAlpha171ControlFrame(alpha223Projection)).toBeUndefined()
    expect(
      normalizeAlpha223ControlFrame({ type: 'projection', sessionId: 's', seq: 5, key: 'todos', value: [] }),
    ).toBeUndefined()
  })
  it('rejects duplicate keys, malformed final Inbox, old value spelling, empty batches and invalid sequence', () => {
    for (const frame of [
      { ...alpha223Projection, changes: [alpha223Projection.changes[0], alpha223Projection.changes[0]] },
      { ...alpha223Projection, changes: [alpha223Projection.changes[0], { key: 'inbox', val: {} }] },
      { ...alpha223Projection, changes: [{ key: 'todos', value: [] }] },
      { ...alpha223Projection, changes: [] },
      { ...alpha223Projection, seq: -1 },
    ])
      expect(normalizeAlpha223ControlFrame(frame)).toBeUndefined()
  })
  it('maps new targets and RRULE while retaining scope evidence only for the Host', async () => {
    const { repository } = harness([alpha223Task])
    expect(await repository.catalog()).toEqual([
      {
        id: alpha223Task.id,
        kind: 'rrule',
        title: alpha223Task.title,
        prompt: alpha223Task.prompt,
        rrule: alpha223Task.rrule,
        scheduledAt: alpha223Task.scheduledAt,
        status: 'paused',
        updatedAt: alpha223Task.updatedAt,
        target: { kind: 'new_once', sessionId: 'reserved-session', agentPreset: 'fixture-preset' },
        targetWorkingDirectory: '/fixture/workspace',
        involvedSessionIds: ['creator-session'],
      },
    ])
  })
  it('sends native creation without a session or model request', async () => {
    const { repository, request } = harness(alpha223Task)
    await repository.create({
      title: 'Review',
      prompt: 'Review project',
      timing: { kind: 'after', seconds: 300 },
      workingDirectory: '/fixture/workspace',
      targetMode: 'new_once',
    })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'schedule/create',
      {
        request: {
          title: 'Review',
          prompt: 'Review project',
          timing: { kind: 'after', after_seconds: 300 },
          target: { kind: 'new_once', create: { cwd: '/fixture/workspace' } },
        },
      },
      undefined,
    )
  })
  it('keeps revisions on edit/delete and returns conflicts and pending runs without replay', async () => {
    const { repository, request } = harness({ id: alpha223Task.id, code: 'schedule_conflict' })
    const expected = {
      id: alpha223Task.id,
      kind: 'at' as const,
      title: 'Review',
      prompt: 'Review project',
      scheduledAt: alpha223Task.scheduledAt,
    }
    expect(
      await repository.update({ id: expected.id, expected, active: false, expectedUpdatedAt: null }),
    ).toMatchObject({ updated: false, code: 'schedule_conflict' })
    expect(request).toHaveBeenLastCalledWith(
      'schedule/edit',
      { request: { id: expected.id, action: 'update', patch: { active: false }, expectedUpdatedAt: null } },
      undefined,
    )
    expect(await repository.delete(undefined, expected.id, undefined, alpha223Task.updatedAt)).toMatchObject({
      deleted: false,
      code: 'schedule_conflict',
    })
    request.mockResolvedValue({ ok: true, value: { id: expected.id, code: 'schedule_execution_pending' } })
    expect(await repository.run(expected.id)).toEqual({
      id: expected.id,
      admitted: false,
      code: 'schedule_execution_pending',
    })
    expect(request).toHaveBeenCalledTimes(3)
    await expect(repository.update({ id: expected.id, expected, active: true })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('preserves cancellation and transport timeout without retrying a mutation', async () => {
    const { repository, request } = harness(alpha223Task)
    await expect(repository.run(alpha223Task.id, AbortSignal.abort())).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(request).not.toHaveBeenCalled()
    const failure = new AppError({ code: 'BACKEND_UNREACHABLE', message: 'Timeout', retryable: true })
    request.mockRejectedValue(failure)
    await expect(repository.run(alpha223Task.id)).rejects.toBe(failure)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
