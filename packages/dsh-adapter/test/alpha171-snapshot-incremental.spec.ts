import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readAlpha171SessionSnapshot,
  readAlpha171SessionSnapshotEnvelope,
  type AlphaV4SessionProfile,
} from '../src/versions/alpha171/session-wire.js'
import {
  expandHistoryRecords,
  expandV4HistoryRecordsIncremental,
} from '../src/versions/alpha/session-wire.js'
import { interruptedNotStartedToolResult } from './rc201-recovery-fixtures.js'

// dsh-v0.1.7-alpha.1 / c36a83ff6bb95e3f82cf79f9be7c724270a8aa61:
// packages/api/session-controller/src/types.ts and session-format-v3-to-v4/src/codec.ts.
const header = { version: 4, id: 's1', createdAt: 1, isSeeded: false }

function event(seq: number, turn = 1): Record<string, unknown> {
  return { type: 'event', event: { type: 'turn/start', seq, time: seq + 1, data: { turn } } }
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

afterEach(() => vi.restoreAllMocks())

describe('alpha171 incremental snapshot decode', () => {
  it('preserves stable sequence order and the eager cursor admission', async () => {
    // seq 3 exceeds the cursor and must be dropped even though it is valid.
    const records = [event(0), event(2), event(1, 11), event(1, 12), event(3)]
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
    expect(incremental.map((entry) => ({ seq: entry.seq, data: entry.data }))).toEqual([
      { seq: 0, data: { turn: 1 } },
      { seq: 1, data: { turn: 11 } },
      { seq: 1, data: { turn: 12 } },
      { seq: 2, data: { turn: 1 } },
    ])
  })

  it('preserves safe markers for unreadable rows without retaining their bodies', async () => {
    const records = [
      null,
      {},
      event(-1),
      event(Number.NaN),
      {
        type: 'event',
        event: { type: 'turn/start', seq: 0, time: 'invalid', data: { body: 'private-fixture' } },
      },
      {
        type: 'event',
        event: { type: 'unknown/fixture', seq: 1, time: 2, data: { body: 'private-fixture' } },
      },
      event(2),
      event(3),
    ]
    const incremental = await expandV4HistoryRecordsIncremental(records, 's1', 2, false)
    const eager = expandHistoryRecords(readAlpha171SessionSnapshot(snapshot(2, records))!.records, 's1', 'v4')

    expect(incremental).toEqual(eager)
    expect(incremental).toEqual([
      { type: 'system/message', seq: 0, time: 0, data: {}, sessionId: 's1' },
      { type: 'system/message', seq: 1, time: 2, data: {}, sessionId: 's1' },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 }, sessionId: 's1' },
    ])
  })

  it.each([false, true])(
    'preserves V4 tool-result projection with auto-review contract %s',
    async (enabled) => {
      const records = [{ type: 'event', event: interruptedNotStartedToolResult }]
      const incremental = await expandV4HistoryRecordsIncremental(records, 's1', 4, enabled)
      const eager = expandHistoryRecords(
        readAlpha171SessionSnapshot(snapshot(4, records))!.records,
        's1',
        'v4',
        enabled,
      )

      expect(incremental).toEqual(eager)
      expect(incremental[0]).toMatchObject({ type: 'tool/result', sessionId: 's1', seq: 4 })
      expect(incremental[0]).toHaveProperty('data.message.content.0.type', 'tool-result')
      expect(incremental[0]).toHaveProperty('data.message.role', 'user')
      if (enabled) expect(incremental[0]).toHaveProperty('autoReviewDenialContract', true)
      else expect(incremental[0]).not.toHaveProperty('autoReviewDenialContract')
    },
  )

  it('uses the version profile for admission and normalization', async () => {
    const profile: AlphaV4SessionProfile = {
      eventValidators: { 'turn/start': (data) => (data as { turn: number }).turn !== 2 },
      validateEvent: vi.fn(),
      normalizeEvent: (value) => ({ ...value, profileNormalized: true }),
    }
    const records = [event(0), event(1, 2), event(2)]
    const incremental = await expandV4HistoryRecordsIncremental(records, 's1', 2, false, profile)
    const eager = expandHistoryRecords(
      readAlpha171SessionSnapshot(snapshot(2, records), profile)!.records,
      's1',
      'v4',
      false,
      profile,
    )

    expect(incremental).toEqual(eager)
    expect(incremental).toEqual([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 }, profileNormalized: true, sessionId: 's1' },
      { type: 'system/message', seq: 1, time: 2, data: {}, sessionId: 's1' },
      { type: 'turn/start', seq: 2, time: 3, data: { turn: 1 }, profileNormalized: true, sessionId: 's1' },
    ])
  })

  it('validates the envelope without admitting its records early', async () => {
    const validateEvent = vi.fn()
    const profile: AlphaV4SessionProfile = { eventValidators: {}, validateEvent }
    const records = [event(0), event(1)]
    const assistantStream = { revision: 0 }
    const source = { ...snapshot(1, records), assistantStream }
    const envelope = readAlpha171SessionSnapshotEnvelope(source, profile)

    expect(envelope).toMatchObject({
      header,
      cursor: 1,
      hasMore: false,
      projections: { asOfSeq: 1, values: {} },
    })
    expect(envelope?.assistantStream).toBe(assistantStream)
    expect(validateEvent).not.toHaveBeenCalled()
    await expandV4HistoryRecordsIncremental(envelope!.records, 's1', envelope!.cursor, false, profile)
    expect(validateEvent).toHaveBeenCalledTimes(records.length)
  })

  it.each([
    ['header', { header: null }],
    ['cursor', { cursor: Number.NaN }],
    ['records', { records: {} }],
    ['hasMore', { hasMore: 'false' }],
    ['projections', { projections: { asOfSeq: 0, values: null } }],
  ])('rejects malformed snapshot %s', (_label, invalid) => {
    expect(readAlpha171SessionSnapshotEnvelope({ ...snapshot(0, [event(0)]), ...invalid })).toBeUndefined()
  })

  it('accepts an empty snapshot at the initial cursor', async () => {
    const envelope = readAlpha171SessionSnapshotEnvelope(snapshot(-1, []))

    expect(envelope?.cursor).toBe(-1)
    await expect(expandV4HistoryRecordsIncremental(envelope!.records, 's1', -1, false)).resolves.toEqual([])
  })

  it('stops admitting rows when cancellation interrupts a decode slice', async () => {
    let clock = 0
    let decoded = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const abort = new AbortController()
    const profile: AlphaV4SessionProfile = {
      eventValidators: {},
      validateEvent: () => {
        decoded++
        clock += 10
      },
    }
    const callback = setImmediate(() => abort.abort())
    try {
      const records = Array.from({ length: 8 }, (_, index) => event(index))
      const result = await expandV4HistoryRecordsIncremental(records, 's1', 7, false, profile, abort.signal)
      expect(result).toEqual([])
      expect(decoded).toBeGreaterThan(0)
      expect(decoded).toBeLessThan(records.length)
    } finally {
      clearImmediate(callback)
    }
  })

  it('allows event-loop callbacks to run before decoding finishes', async () => {
    let clock = 0
    let decoded = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const profile: AlphaV4SessionProfile = {
      eventValidators: {},
      validateEvent: () => {
        // Advance the decoder's budget without busy-waiting or faking setImmediate.
        decoded += 1
        clock += 60
      },
    }
    const records = Array.from({ length: 8 }, (_, index) => event(index))
    const observedProgress: number[] = []
    let callback: NodeJS.Immediate
    const observeProgress = (): void => {
      observedProgress.push(decoded)
      callback = setImmediate(observeProgress)
    }
    callback = setImmediate(observeProgress)
    try {
      const result = await expandV4HistoryRecordsIncremental(records, 's1', 7, false, profile)
      expect(result).toHaveLength(records.length)
      expect(decoded).toBe(records.length)
      // Without a real event-loop yield this array stays empty: zero callbacks
      // must never be mistaken for a zero scheduling delay.
      expect(observedProgress.length).toBeGreaterThan(1)
      expect(observedProgress[0]).toBeGreaterThan(0)
      expect(observedProgress[0]).toBeLessThan(records.length)
      expect(new Set(observedProgress).size).toBeGreaterThan(1)
    } finally {
      clearImmediate(callback)
    }
  })
})
