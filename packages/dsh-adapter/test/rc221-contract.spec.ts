import { describe, expect, it } from 'vitest'
import type { ScheduleRepository } from '@dsh-vscode/domain'
import { AlphaLoopbackApiClient } from '../src/versions/alpha/transport.js'
import { Rc221VersionAdapter } from '../src/versions/rc221/adapter.js'
import { rc221Projection, rc221Task } from './fixtures/rc221-contract.js'
import { bodyText, endpoint, transportOptions, wrappedResponse } from './support/contract-harness.js'

class Adapter extends Rc221VersionAdapter {
  public normalize(value: unknown): readonly unknown[] | undefined {
    return this.createTransportOptions(endpoint).normalizeControlFrame?.(value)
  }

  public schedules(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return this.createScheduleRepository(transport)
  }
}

describe('published rc221 consumed wire', () => {
  it('accepts batched projections atomically and rejects the earlier single-key spelling', () => {
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(adapter.normalize(rc221Projection)).toMatchObject([
      { type: 'session/projection', seq: 5, key: 'todos' },
      { type: 'session/queue', asOfSequence: 5, items: [] },
      { type: 'session/projection', seq: 5, key: 'inbox' },
    ])
    expect(
      adapter.normalize({ type: 'projection', sessionId: 's', seq: 5, key: 'todos', value: [] }),
    ).toBeUndefined()
    expect(() =>
      adapter.normalize({
        ...rc221Projection,
        changes: [
          rc221Projection.changes[1],
          { key: 'todos', val: [{ content: 'Invalid', status: 'unknown' }] },
        ],
      }),
    ).toThrow('malformed todo')
  })

  it('uses native Schedule request envelopes and preserves revision refusals without replay', async () => {
    const requests: unknown[] = []
    let reply: unknown = [rc221Task]
    const options = transportOptions((_url, init) => {
      requests.push(JSON.parse(bodyText(init)))
      return Promise.resolve(wrappedResponse(init, reply))
    })
    const adapter = new Adapter(options)
    const transport = new AlphaLoopbackApiClient({ ...options, endpoint })
    try {
      const schedules = adapter.schedules(transport)
      expect(await schedules.catalog()).toMatchObject([
        {
          id: rc221Task.id,
          kind: 'rrule',
          target: { kind: 'new_once' },
          targetWorkingDirectory: '/fixture/workspace',
        },
      ])
      reply = { id: rc221Task.id, code: 'schedule_conflict' }
      expect(await schedules.delete(undefined, rc221Task.id, undefined, rc221Task.updatedAt)).toEqual({
        id: rc221Task.id,
        deleted: false,
        code: 'schedule_conflict',
      })
      expect(requests).toMatchObject([
        { method: 'schedule/catalog', payload: { args: {} } },
        {
          method: 'schedule/edit',
          payload: {
            args: {
              request: {
                id: rc221Task.id,
                action: 'delete',
                expectedUpdatedAt: rc221Task.updatedAt,
              },
            },
          },
        },
      ])
    } finally {
      await transport.close()
    }
  })
})
