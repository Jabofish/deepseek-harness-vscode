import { describe, expect, it } from 'vitest'
import type { BackendEvent, SessionProjectionValues } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'
import {
  expandHistoryRecords,
  normalizeAlphaEvent,
  readAlphaWireEventFrame,
} from '../src/versions/alpha/session-wire.js'
import { UNREADABLE_HISTORY_EVENT } from '../src/versions/alpha171/session-wire.js'
import { Alpha231VersionAdapter } from '../src/versions/alpha231/adapter.js'
import { alpha231SessionProfile } from '../src/versions/alpha231/session-wire.js'
import { Alpha232VersionAdapter } from '../src/versions/alpha232/adapter.js'
import { rc222SessionProfile } from '../src/versions/rc222/session-wire.js'
import type { Rc222SubagentRepository } from '../src/versions/rc222/subagent-repository.js'
import { rc222NamedChild } from './fixtures/rc222-session-contract.js'
import {
  alpha231CardDecision,
  alpha231DirectoryEvents,
  alpha231SystemUpdate,
} from './fixtures/alpha231-contract.js'
import { transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

const sessionId = 'fixture-session'
const alphaAdapters: readonly { name: string; AdapterBase: typeof Alpha231VersionAdapter }[] = [
  { name: 'alpha231', AdapterBase: Alpha231VersionAdapter },
  { name: 'alpha232', AdapterBase: Alpha232VersionAdapter },
]

function frame(event: object): { readonly type: 'event'; readonly event: object } {
  return { type: 'event', event }
}

describe('published DSH 0.2.3 Alpha Session V4 contract', () => {
  it('uses only Host workspace moves for the working directory in history and live follow', () => {
    const records = [frame(alpha231DirectoryEvents.legacy), frame(alpha231DirectoryEvents.current)]
    const expected = [
      { type: 'system/message', sessionId, seq: 4, time: 1_004, data: {} },
      {
        type: 'session/projection',
        sessionId,
        seq: 5,
        time: 1_005,
        data: { key: 'workingDirectory', value: alpha231DirectoryEvents.current.data.cwd, seq: 5 },
      },
    ]
    expect(expandHistoryRecords(records, sessionId, 'v4', false, alpha231SessionProfile)).toEqual(expected)
    expect(normalizeEnvelope({ type: 'session/event', sessionId, event: expected[1] })).toEqual({
      type: 'session.projection',
      sessionId,
      sequence: 5,
      key: 'workingDirectory',
      value: alpha231DirectoryEvents.current.data.cwd,
    })
    expect(
      records.map((record) =>
        normalizeAlphaEvent(
          readAlphaWireEventFrame(record, 'v4', alpha231SessionProfile)?.event,
          sessionId,
          'v4',
          false,
          alpha231SessionProfile,
        ),
      ),
    ).toEqual(expected)
    expect(readAlphaWireEventFrame(records[1], 'v4', rc222SessionProfile)?.event.type).toBe(
      UNREADABLE_HISTORY_EVENT,
    )
    expect(expandHistoryRecords(records, sessionId, 'v4', false, rc222SessionProfile)[0]).toMatchObject({
      type: 'session/projection',
      data: { key: 'workingDirectory', value: '/fixture/old' },
    })
  })

  it.each(['relative/path', '/fixture/with\0nul', { path: '/fixture/root' }])(
    'keeps malformed workspace roots opaque (%j)',
    (cwd) => {
      const record = frame({ ...alpha231DirectoryEvents.current, data: { cwd } })
      expect(readAlphaWireEventFrame(record, 'v4', alpha231SessionProfile)?.event).toMatchObject({
        type: UNREADABLE_HISTORY_EVENT,
        seq: 5,
        data: {},
      })
    },
  )

  it('admits structured system updates and card decisions without publishing their bodies', () => {
    const card = frame(alpha231CardDecision)
    const system = frame(alpha231SystemUpdate)
    expect(readAlphaWireEventFrame(card, 'v4', alpha231SessionProfile)?.event).toEqual(alpha231CardDecision)
    expect(readAlphaWireEventFrame(system, 'v4', alpha231SessionProfile)?.event).toEqual(alpha231SystemUpdate)
    const events = expandHistoryRecords([card, system], sessionId, 'v4', false, alpha231SessionProfile)
    expect(events.map((event) => normalizeEnvelope({ type: 'session/event', sessionId, event }))).toEqual([
      { type: 'session.system', sessionId, sequence: 6 },
      { type: 'session.system', sessionId, sequence: 7 },
    ])
    const invalid = frame({ ...alpha231CardDecision, data: { cardId: 'fixture-answer', phase: 'settled' } })
    expect(readAlphaWireEventFrame(invalid, 'v4', alpha231SessionProfile)?.event.type).toBe(
      UNREADABLE_HISTORY_EVENT,
    )
  })

  it.each(alphaAdapters)(
    '$name keeps optional action-card state out of projection reads, baselines and updates',
    ({ AdapterBase }) => {
      class Adapter extends AdapterBase {
        public event(event: BackendEvent): BackendEvent {
          return this.mapBackendEvent(event)
        }
        public values(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
          return this.mapProjectionValues(values)
        }
      }
      const adapter = new Adapter(transportOptions(globalThis.fetch))
      const actionCards = { proposals: {}, decisions: { 'fixture-answer': alpha231CardDecision.data } }
      const projection = { asOfSequence: 6, values: { title: 'Fixture title', actionCards } }
      const visible = { title: 'Fixture title', todoList: null }
      expect(adapter.values(projection.values)).toEqual(visible)
      expect(adapter.event({ type: 'session.subscribed', sessionId, lastSequence: 6, projection })).toEqual({
        type: 'session.subscribed',
        sessionId,
        lastSequence: 6,
        projection: { asOfSequence: 6, values: visible },
      })
      expect(
        adapter.event({ type: 'session.projection.baseline', projections: { [sessionId]: projection } }),
      ).toEqual({
        type: 'session.projection.baseline',
        projections: { [sessionId]: { asOfSequence: 6, values: visible } },
      })
      expect(
        adapter.event({
          type: 'session.projection',
          sessionId,
          key: 'actionCards',
          value: actionCards,
          sequence: 6,
        }),
      ).toEqual({ type: 'session.system', sessionId })
    },
  )

  it.each(alphaAdapters)(
    '$name removes private card data from the child history repository',
    async ({ AdapterBase }) => {
      class Adapter extends AdapterBase {
        public childRepository(transport: DshTransport): Rc222SubagentRepository {
          return this.createSubagentRepository(transport, {})
        }
      }
      class ChildHistoryTransport extends ProbeFixtureTransport {
        public override request<TResponse>(method: string): Promise<TResponse> {
          const value =
            method === 'session.list'
              ? { items: [] }
              : {
                  events: [],
                  hasMore: false,
                  projections: {
                    asOfSeq: 6,
                    values: {
                      title: 'Child title',
                      conversationContinuation: 5,
                      actionCards: {
                        proposals: {},
                        decisions: { 'fixture-answer': alpha231CardDecision.data },
                      },
                    },
                  },
                }
          return Promise.resolve({ rpcId: 'fixture', result: { ok: true, value } } as TResponse)
        }
        public override remoteRequest<TResponse>(
          method = '',
          args: Readonly<Record<string, unknown>> = {},
        ): Promise<TResponse> {
          if (method !== 'session/projections') return Promise.reject(new Error('Unexpected fixture Remote'))
          const sessionId = (args.request as { sessionId?: string } | undefined)?.sessionId
          return Promise.resolve({
            ok: true,
            value: {
              kind: 'sequenced',
              asOfSeq: 6,
              values: { subagentCatalog: sessionId === 'root' ? [rc222NamedChild] : [] },
            },
          } as TResponse)
        }
      }
      const transport = new ChildHistoryTransport()
      const repository = new Adapter(transportOptions(globalThis.fetch)).childRepository(transport)
      try {
        await repository.list('root')
        const page = await repository.history('child')
        expect(page.projection).toEqual({
          asOfSequence: 6,
          values: { title: 'Child title', conversationContinuation: 5 },
        })
      } finally {
        await transport.close()
      }
    },
  )
})
