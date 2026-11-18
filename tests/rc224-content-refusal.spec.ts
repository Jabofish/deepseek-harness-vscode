import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../packages/dsh-adapter/src/contracts.js'
import { Rc224VersionAdapter } from '../packages/dsh-adapter/src/versions/rc224/adapter.js'
import { rc222SessionProfile } from '../packages/dsh-adapter/src/versions/rc222/session-wire.js'
import { readAlpha171SessionSnapshot } from '../packages/dsh-adapter/src/versions/alpha171/session-wire.js'
import { rc6Mapper } from '../packages/dsh-adapter/src/versions/rc6/mapper.js'
import {
  rc224RefusalAttemptEvent,
  rc224RefusalMessage,
  rc224RefusalSnapshot,
  rc224RefusalTurnEndEvent,
} from '../packages/dsh-adapter/test/fixtures/rc224-contract.js'
import { candidate, transportOptions } from '../packages/dsh-adapter/test/support/contract-harness.js'
import { ProbeFixtureTransport } from '../packages/dsh-adapter/test/support/probe-fixture.js'
import { reduceTimelineBatch, type TimelineState } from '../packages/timeline/src/index.js'

describe('rc224 DeepSeek content refusal timeline projection', () => {
  it('withdraws streamed draft output on assistant/attempt and records CONTENT_REFUSED on turn-terminal', async () => {
    const fixture = new ProbeFixtureTransport()
    class Adapter extends Rc224VersionAdapter {
      public override createTransport(): DshTransport {
        return fixture
      }
    }
    const adapter = new Adapter(transportOptions(globalThis.fetch))
    expect(await adapter.probe(candidate('0.2.2-rc.4'))).toMatchObject({
      adapterId: 'dsh-0.2.2-rc.4',
      protocolVersion: 'rc224',
    })

    const sessionId = 'rc224-refusal-session'
    const livePrefix = rc224RefusalSnapshot.records.slice(0, 5).map(({ event }) => ({
      sequence: event.seq,
      event: rc6Mapper.event(event.type, { ...event, sessionId }),
    }))
    const initial: TimelineState = { sessionId, nodes: [], lastSequence: -1 }
    const streaming = reduceTimelineBatch(initial, [
      ...livePrefix,
      {
        sequence: 5,
        advanceSequence: false,
        event: {
          type: 'message.delta',
          sessionId,
          messageId: 'transient:rc224:1:1',
          delta: 'Draft before refusal.',
          turn: 1,
          step: 1,
          transientAttemptId: 'attempt-refused',
          transientIndex: 0,
          transientSequence: 1,
          transientStartedAfterSequence: 4,
        },
      },
    ])
    expect(streaming.nodes.some((node) => node.kind === 'assistant-message')).toBe(true)

    const validated = readAlpha171SessionSnapshot(rc224RefusalSnapshot, rc222SessionProfile)
    expect(validated).toBeDefined()
    const attemptEvent = rc6Mapper.event(rc224RefusalAttemptEvent.type, {
      ...rc224RefusalAttemptEvent,
      sessionId,
    })
    const turnEndEvent = rc6Mapper.event(rc224RefusalTurnEndEvent.type, {
      ...rc224RefusalTurnEndEvent,
      sessionId,
    })
    const settled = reduceTimelineBatch(streaming, [
      { sequence: rc224RefusalAttemptEvent.seq, event: attemptEvent },
      { sequence: rc224RefusalTurnEndEvent.seq, event: turnEndEvent },
    ])

    expect(settled.nodes.filter((node) => node.kind === 'assistant-message')).toEqual([])
    expect(settled.nodes).toContainEqual({
      kind: 'turn-terminal',
      id: 'turn-terminal:1',
      turn: 1,
      sequence: rc224RefusalTurnEndEvent.seq,
      reason: 'error',
      failure: {
        code: 'CONTENT_REFUSED',
        message: rc224RefusalMessage,
      },
    })
  })
})
