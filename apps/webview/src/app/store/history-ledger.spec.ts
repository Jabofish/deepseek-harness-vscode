import { describe, expect, it } from 'vitest'
import type { SessionHistoryEvent } from '@dsh-vscode/domain'
import { mergeHistory } from './history-ledger.js'

function delta(
  sequence: number,
  messageId = 'answer',
  kind: 'message.delta' | 'reasoning.delta' = 'message.delta',
): SessionHistoryEvent {
  return {
    sequence,
    time: '2026-01-01T00:00:00.000Z',
    event: { type: kind, sessionId: 'session', messageId, delta: `part-${sequence}` },
  }
}

describe('durable history ledger', () => {
  it('retains distinct same-sequence events and merges replay coverage without changing inputs', () => {
    const text = delta(7)
    const reasoning = delta(7, 'answer', 'reasoning.delta')
    const current = Object.freeze([text, reasoning])
    const first = mergeHistory(current, [{ ...text, coveredSequences: [5, 7] }])
    const next = mergeHistory(first, [{ ...text, coveredSequences: [6, 7] }, reasoning])
    expect(next).toEqual([{ ...text, coveredSequences: [5, 6, 7] }, reasoning])
    expect(current).toEqual([text, reasoning])
    expect(first[0]?.coveredSequences).toEqual([5, 7])
    expect(mergeHistory(next, [])).toBe(next)
  })

  it('removes covered raw deltas while preserving other messages, reasoning and explicit coverage', () => {
    const compacted = { ...delta(9), coveredSequences: [1, 3, 9] }
    const differentMessage = delta(1, 'other')
    const reasoning = delta(3, 'answer', 'reasoning.delta')
    const explicitCoverage = { ...delta(1), coveredSequences: [1] }
    expect(
      mergeHistory(
        [compacted],
        [delta(1), delta(3), differentMessage, reasoning, explicitCoverage, delta(4)],
      ),
    ).toEqual([explicitCoverage, differentMessage, reasoning, delta(4), compacted])
  })

  it('indexes compaction coverage once rather than scanning it for every retained delta', () => {
    let coverageReads = 0
    const compacted = Array.from({ length: 100 }, (_, index): SessionHistoryEvent => ({
      ...delta(5000 + index),
      get coveredSequences(): readonly number[] {
        coverageReads += 1
        return [index + 1, 5000 + index]
      },
    }))
    const current = [
      ...Array.from({ length: 300 }, (_, index) => delta(1000 + index, `other-${index}`)),
      ...compacted,
    ]
    const older = Array.from({ length: 100 }, (_, index) => delta(index + 1))
    const merged = mergeHistory(current, older)
    expect(merged).toEqual(current)
    expect(coverageReads).toBeLessThan(4000)
  })
})
