import { describe, expect, it } from 'vitest'
import {
  readAlpha171SessionSnapshot,
  readAlpha171SessionSnapshotEnvelope,
  type AlphaV4SessionProfile,
} from '../src/versions/alpha171/session-wire.js'
import {
  expandHistoryRecords,
  expandV4HistoryRecordsIncremental,
} from '../src/versions/alpha/session-wire.js'

const header = { version: 4, id: 's1', createdAt: 1, isSeeded: false }

function event(seq: number): Record<string, unknown> {
  return { type: 'event', event: { type: 'turn/start', seq, time: seq + 1, data: { turn: 1 } } }
}

function snapshot(cursor: number, records: unknown[]): Record<string, unknown> {
  return {
    type: 'snapshot',
    header,
    cursor,
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
    records,
  }
}

describe('alpha171 incremental snapshot decode', () => {
  it('matches the eager decode, including the seq <= cursor admission', async () => {
    // seq 3 exceeds the cursor and must be dropped even though it is valid.
    const records = [event(0), event(2), event(1), event(3)]
    const source = snapshot(2, records)
    const eager = expandHistoryRecords(readAlpha171SessionSnapshot(source)!.records, 's1', 'v4', false)
    const envelope = readAlpha171SessionSnapshotEnvelope(source)
    const incremental = await expandV4HistoryRecordsIncremental(
      envelope!.records,
      's1',
      envelope!.cursor,
      false,
    )
    expect(incremental).toEqual(eager)
    expect(incremental.map((entry) => entry.seq)).toEqual([0, 1, 2])
  })

  it('yields to the event loop during a large decode', async () => {
    const slowProfile: AlphaV4SessionProfile = {
      eventValidators: {},
      validateEvent: () => {
        // Simulate the synchronous V4 codec admission cost.
        const end = Date.now() + 2
        while (Date.now() < end) {
          /* spin */
        }
      },
    }
    const records = Array.from({ length: 400 }, (_, index) => event(index))
    let last = Date.now()
    let maxGap = 0
    const ticker = setInterval(() => {
      const now = Date.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 5)
    try {
      await expandV4HistoryRecordsIncremental(records, 's1', 399, false, slowProfile)
    } finally {
      clearInterval(ticker)
    }
    // 400 records x ~2ms ~= 800ms of synchronous work. Without cooperative yields
    // the event loop would be blocked for the whole decode (maxGap ~= 800ms); the
    // ~100ms yield cadence keeps the observed gap well below that.
    expect(maxGap).toBeLessThan(300)
  })
})
