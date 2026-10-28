import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@dsh-vscode/domain'

import type { TimelineNode } from '../src/nodes.js'
import { buildTrajectory, searchTrajectoryRecords } from '../src/trajectory.js'

const usage: TokenUsage = {
  inputTokens: 120,
  outputTokens: 34,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  reasoningTokens: 12,
}

it('retains complete tool failure and denial information in trajectory output', () => {
  const error = 'Failure context\n'.repeat(600) + 'ERROR_END'
  const projection = buildTrajectory([
    {
      kind: 'tool',
      id: 'failed',
      tool: {
        id: 'failed',
        name: 'shell',
        title: 'shell',
        category: 'execution',
        status: 'failed',
        outputSummary: 'Partial stdout',
        error,
        autoReviewDenial: { reason: 'The requested target is outside the allowed scope.' },
        metadata: {},
      },
    },
  ])
  expect(projection.sections[0]?.records[0]?.outputDetail).toBe(
    'Partial stdout\n\n' + error + '\n\nThe requested target is outside the allowed scope.',
  )
})

const nodes: readonly TimelineNode[] = [
  {
    kind: 'user-message',
    id: 'u1',
    markdown: 'Fix the failing test\nin parser.spec.ts',
  },
  {
    kind: 'assistant-message',
    id: 'a1',
    markdown: 'I will inspect the test first.',
    streaming: false,
    modelLabel: 'deepseek-chat',
    usage,
    reasoning: { markdown: 'The parser spec fails on edge cases.', streaming: false },
  },
  {
    kind: 'tool',
    id: 't1',
    tool: {
      id: 't1',
      name: 'shell',
      category: 'execution',
      title: 'shell: pnpm test',
      status: 'completed',
      startedAt: '2026-08-17T05:00:00.000Z',
      completedAt: '2026-08-17T05:00:02.500Z',
      inputSummary: 'pnpm test',
      outputSummary: '1 failed',
      metadata: {},
    },
  },
  {
    kind: 'user-message',
    id: 'u2',
    markdown: 'Injected agent instructions',
    source: 'plugin',
  },
  {
    kind: 'compaction',
    id: 'c1',
    compaction: { id: 'c1', phase: 'end', replacedCount: 12, estimatedTokens: 9000 },
  },
  {
    kind: 'user-message',
    id: 'u3',
    markdown: 'Continue',
  },
  {
    kind: 'tool',
    id: 't2',
    tool: {
      id: 't2',
      name: 'shell',
      category: 'execution',
      title: 'shell: pnpm test',
      status: 'running',
      startedAt: '2026-08-17T05:01:00.000Z',
      inputSummary: 'pnpm test',
      metadata: {},
    },
  },
  {
    kind: 'notice',
    id: 'n1',
    level: 'info',
    text: 'not part of the ledger',
  },
]

describe('buildTrajectory', () => {
  it('opens numbered turns at user records and numbers records continuously', () => {
    const projection = buildTrajectory(nodes)
    expect(projection.recordCount).toBe(7)
    const turns = projection.sections.filter((section) => section.kind === 'turn')
    expect(turns.map((section) => (section.kind === 'turn' ? section.turn : -1))).toEqual([1, 2])
    const firstUser = turns[0]
    if (firstUser?.kind !== 'turn') throw new Error('expected turn section')
    expect(firstUser.records[0]?.index).toBe(1)
    expect(firstUser.records[0]?.opensTurn).toBe(true)
    expect(turns[1]?.kind).toBe('turn')
    if (turns[1]?.kind !== 'turn') throw new Error('expected turn section')
    expect(turns[1].records[0]?.index).toBe(6)
  })

  it('keeps a standalone compaction in its own between-turns section', () => {
    const projection = buildTrajectory(nodes)
    const between = projection.sections.filter((section) => section.kind === 'between-turns')
    expect(between).toHaveLength(1)
    if (between[0]?.kind !== 'between-turns') throw new Error('expected between-turns section')
    expect(between[0].records[0]?.kind).toBe('compacted')
    expect(between[0].records[0]?.text).toContain('12 replaced')
    expect(between[0].records[0]?.streaming).toBe(false)
  })

  it('carries assistant usage, reasoning, and model label for the inspector', () => {
    const projection = buildTrajectory(nodes)
    const message = projection.sections
      .flatMap((section) => section.records)
      .find((record) => record.id === 'message\u0000a1')
    expect(message?.usage).toEqual(usage)
    expect(message?.thinkingDetail).toBe('The parser spec fails on edge cases.')
    expect(message?.modelLabel).toBe('deepseek-chat')
  })
})

describe('searchTrajectoryRecords', () => {
  it('matches summaries and inspector payloads case-insensitively', () => {
    const projection = buildTrajectory(nodes)
    expect(searchTrajectoryRecords(projection, 'parser')).toHaveLength(2)
    expect(searchTrajectoryRecords(projection, 'parser.spec')).toHaveLength(1)
    expect(searchTrajectoryRecords(projection, 'EDGE CASES')).toHaveLength(1)
    expect(searchTrajectoryRecords(projection, '')).toHaveLength(0)
  })
})

/** Seeded LCG so a failing sequence can be replayed from the printed snapshot. */

/**
 * One snapshot transition from the shapes the reducer produces: append a new
 * node, complete the streaming tail in place (new object identity), rewrite an
 * older node after a late durable projection, or drop the tail.
 */
