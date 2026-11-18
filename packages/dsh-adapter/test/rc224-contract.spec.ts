import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc224VersionAdapter } from '../src/versions/rc224/adapter.js'
import { Rc223VersionAdapter } from '../src/versions/rc223/adapter.js'
import { rc222SessionProfile } from '../src/versions/rc222/session-wire.js'
import {
  validAlpha171SessionSnapshot,
  readAlpha171SessionSnapshot,
} from '../src/versions/alpha171/session-wire.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'
import { rc213BillingPage } from '../src/versions/rc213/billing.js'
import {
  rc224RefusalAttemptEvent,
  rc224RefusalMessage,
  rc224RefusalSnapshot,
  rc224RefusalTurnEndEvent,
} from './fixtures/rc224-contract.js'
import { candidate, transportOptions } from './support/contract-harness.js'
import { ProbeFixtureTransport } from './support/probe-fixture.js'

describe('published rc224 consumed contracts', () => {
  it('admits 0.2.2-rc.4 only and rejects adjacent releases including rc.3 and rc.5', async () => {
    const rc224Probe = new ProbeFixtureTransport()
    const rc223Probe = new ProbeFixtureTransport()
    class Rc224Adapter extends Rc224VersionAdapter {
      public override createTransport(): DshTransport {
        return rc224Probe
      }
    }
    class Rc223Adapter extends Rc223VersionAdapter {
      public override createTransport(): DshTransport {
        return rc223Probe
      }
    }
    const rc224 = new Rc224Adapter(transportOptions(globalThis.fetch))
    const rc223 = new Rc223Adapter(transportOptions(globalThis.fetch))

    expect(await rc224.probe(candidate('0.2.2-rc.4'))).toMatchObject({
      adapterId: 'dsh-0.2.2-rc.4',
      protocolVersion: 'rc224',
      dshVersion: '0.2.2-rc.4',
      compatibilityMode: 'exact',
    })
    expect(await rc224.probe(candidate('0.2.2-rc.3'))).toBeUndefined()
    expect(await rc224.probe(candidate('0.2.2-rc.5'))).toBeUndefined()
    expect(await rc223.probe(candidate('0.2.2-rc.4'))).toBeUndefined()
    expect(rc224Probe.closeCalls).toBe(1)
    expect(rc223Probe.closeCalls).toBe(0)
  })

  it('validates CONTENT_REFUSED assistant/attempt and turn/end V4 history, billed usage, and error projection', () => {
    expect(validAlpha171SessionSnapshot(rc224RefusalSnapshot, rc222SessionProfile)).toBe(true)
    const validated = readAlpha171SessionSnapshot(rc224RefusalSnapshot, rc222SessionProfile)
    expect(validated?.records).toHaveLength(rc224RefusalSnapshot.records.length)

    const mapped = rc6Mapper.history(
      { events: validated!.records, hasMore: false, projections: validated!.projections },
      'rc224-refusal-session',
    )
    expect(mapped.events.map((entry) => entry.event)).toContainEqual({
      type: 'assistant.attempt',
      sessionId: 'rc224-refusal-session',
      sequence: rc224RefusalAttemptEvent.seq,
      turn: 1,
      step: 1,
      time: rc224RefusalAttemptEvent.time,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    })
    expect(mapped.events.map((entry) => entry.event)).toContainEqual({
      type: 'turn.ended',
      sessionId: 'rc224-refusal-session',
      sequence: rc224RefusalTurnEndEvent.seq,
      turn: 1,
      reason: 'error',
      failure: {
        code: 'CONTENT_REFUSED',
        message: rc224RefusalMessage,
      },
    })

    const billing = rc213BillingPage(validated!.records, false)
    expect(billing.facts).toEqual([
      {
        kind: 'route',
        sequence: 3,
        route: { providerId: 'deepseek-official', modelId: 'deepseek-v4-flash' },
      },
      {
        kind: 'attempt',
        sequence: rc224RefusalAttemptEvent.seq,
        time: rc224RefusalAttemptEvent.time,
        startedAt: 1_001,
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      },
    ])
  })
})
