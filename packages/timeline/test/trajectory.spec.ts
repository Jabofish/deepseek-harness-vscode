import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '@dsh-vscode/domain'

import type { TimelineNode } from '../src/nodes.js'
import { buildTrajectory, createTrajectoryProjector, searchTrajectoryRecords } from '../src/trajectory.js'

const usage: TokenUsage = {
  inputTokens: 120,
  outputTokens: 34,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  reasoningTokens: 12,
}

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
  it('keeps context before the first direct user inside turn one, never turn zero', () => {
    const projection = buildTrajectory([
      { kind: 'user-message', id: 'context-first', markdown: 'Injected setup', source: 'plugin' },
      { kind: 'user-message', id: 'first-user', markdown: 'Start work' },
    ])
    expect(projection.sections).toHaveLength(1)
    const section = projection.sections[0]
    expect(section?.kind).toBe('turn')
    if (section?.kind !== 'turn') throw new Error('expected turn section')
    expect(section.turn).toBe(1)
    expect(section.records.map((record) => record.kind)).toEqual(['context', 'user'])
    expect(section.records.map((record) => record.index)).toEqual([1, 2])
  })

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

  it('classifies injected user messages as context records inside the owning turn', () => {
    const projection = buildTrajectory(nodes)
    const injected = projection.sections
      .flatMap((section) => section.records)
      .find((record) => record.id === 'context\u0000u2')
    expect(injected?.kind).toBe('context')
    expect(injected?.opensTurn).toBe(false)
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

  it('derives tool duration from timestamps and leaves running rows blank', () => {
    const projection = buildTrajectory(nodes)
    const records = projection.sections.flatMap((section) => section.records)
    const completed = records.find((record) => record.id === 'tool\u0000t1')
    const running = records.find((record) => record.id === 'tool\u0000t2')
    expect(completed?.timeSeconds).toBe(2.5)
    expect(completed?.startedAt).toBe(Date.parse('2026-08-17T05:00:00.000Z'))
    expect(completed?.isError).toBe(false)
    expect(running?.timeSeconds).toBeNull()
    expect(running?.streaming).toBe(true)
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

  it('shows assistant duration from the DSH step timing boundaries', () => {
    const projection = buildTrajectory([
      { kind: 'user-message', id: 'u-timed', markdown: 'Timed request' },
      {
        kind: 'assistant-message',
        id: 'a-timed',
        markdown: 'Completed answer',
        streaming: false,
        timing: { stepStartTime: 1_000, firstTokenTime: 1_800, completedTime: 4_800 },
      },
    ])
    const message = projection.sections
      .flatMap((section) => section.records)
      .find((record) => record.id === 'message\u0000a-timed')
    expect(message?.timeSeconds).toBe(3.8)
    expect(message?.startedAt).toBe(1_000)
  })

  it('excludes node kinds outside the ledger closed set', () => {
    const projection = buildTrajectory(nodes)
    const texts = projection.sections.flatMap((section) => section.records).map((record) => record.text)
    expect(texts.some((text) => text.includes('not part of the ledger'))).toBe(false)
  })

  it('matches full folding while reusing a stable prefix for streaming updates', () => {
    const project = createTrajectoryProjector()
    const firstNodes = nodes
      .slice(0, 2)
      .map((node, index) =>
        index === 1 && node.kind === 'assistant-message' ? { ...node, streaming: true } : node,
      )
    const first = project(firstNodes)
    const nextNodes = nodes.map((node, index) =>
      index === 1 && node.kind === 'assistant-message'
        ? { ...node, markdown: `${node.markdown} Updated`, streaming: true }
        : node,
    )

    const next = project(nextNodes, 1, firstNodes)

    expect(next).toEqual(buildTrajectory(nextNodes))
    expect(next.recordCount).toBe(7)
    expect(first.sections[0]?.records[0]).toBe(next.sections[0]?.records[0])
  })
})

describe('createTrajectoryProjector incremental folding', () => {
  /**
   * The projector keeps a checkpoint at the last stable work boundary and folds
   * only the live suffix. That is the same class of "incremental result must
   * equal a full rebuild" risk the reducer was audited for, so it is checked by
   * differential replay: every generated snapshot has to match buildTrajectory
   * exactly, through both the caller-hint path and the identity-prefix path.
   */
  it('matches a full rebuild after every generated snapshot', () => {
    const random = createRandom(0x5eed)
    for (let run = 0; run < 40; run += 1) {
      const hinted = createTrajectoryProjector()
      const identity = createTrajectoryProjector()
      let previous: readonly TimelineNode[] = []
      let serial = 0
      const nextId = (prefix: string): string => `${prefix}-${run}-${(serial += 1)}`

      for (let step = 0; step < 30; step += 1) {
        const next = applyRandomSnapshotStep(previous, random, nextId)
        const expected = buildTrajectory(next)

        const fromHint = hinted(next, firstChangedIndex(previous, next), previous)
        expect(fromHint).toStrictEqual(expected)
        // The identity fallback (a caller that cannot name the change point, or
        // hands over an equal array instance) has to agree with the same rebuild.
        const fromIdentity = identity(next.slice())
        expect(fromIdentity).toStrictEqual(expected)

        previous = next
      }
    }
  })

  it('returns the cached projection for the same array instance', () => {
    const project = createTrajectoryProjector()
    const snapshot: readonly TimelineNode[] = [...nodes]
    const first = project(snapshot)
    // The reducer hands over a new array per snapshot, so an identical instance
    // means "nothing changed" and must not be refolded.
    expect(project(snapshot)).toBe(first)
    expect(project([...nodes])).not.toBe(first)
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

  it('returns nothing when the query is blank or unmatched', () => {
    const projection = buildTrajectory(nodes)
    expect(searchTrajectoryRecords(projection, '   ')).toHaveLength(0)
    expect(searchTrajectoryRecords(projection, 'no-such-needle')).toHaveLength(0)
  })
})

/** Seeded LCG so a failing sequence can be replayed from the printed snapshot. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

function firstChangedIndex(
  previous: readonly TimelineNode[],
  next: readonly TimelineNode[],
): number | undefined {
  const limit = Math.min(previous.length, next.length)
  let index = 0
  while (index < limit && previous[index] === next[index]) index += 1
  return index === previous.length && index === next.length ? undefined : index
}

function settledAssistant(id: string, markdown: string): TimelineNode {
  return {
    kind: 'assistant-message',
    id,
    markdown,
    streaming: false,
    timing: { stepStartTime: 1_000, firstTokenTime: 1_400, completedTime: 3_600 },
    usage,
  }
}

function runningTool(id: string): TimelineNode {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      name: 'shell',
      category: 'execution',
      title: `shell: step ${id}`,
      status: 'running',
      metadata: {},
    },
  }
}

function nonLedgerNode(id: string): TimelineNode {
  return { kind: 'notice', id, level: 'info', text: `notice ${id}` }
}

/**
 * One snapshot transition from the shapes the reducer produces: append a new
 * node, complete the streaming tail in place (new object identity), rewrite an
 * older node after a late durable projection, or drop the tail.
 */
function applyRandomSnapshotStep(
  previous: readonly TimelineNode[],
  random: () => number,
  nextId: (prefix: string) => string,
): readonly TimelineNode[] {
  const nodes = previous.slice()
  const last = nodes.at(-1)
  const pick = random()

  if (pick < 0.22) {
    nodes.push({
      kind: 'user-message',
      id: nextId('user'),
      markdown: `Request ${previous.length}`,
      ...(random() < 0.3 ? { source: 'plugin' } : {}),
    })
  } else if (pick < 0.44) {
    nodes.push({
      kind: 'assistant-message',
      id: nextId('assistant'),
      markdown: `Working ${previous.length}`,
      streaming: true,
      ...(random() < 0.4 ? { reasoning: { markdown: `Thinking ${previous.length}`, streaming: true } } : {}),
    })
  } else if (pick < 0.58 && last?.kind === 'assistant-message' && last.streaming) {
    nodes[nodes.length - 1] = settledAssistant(last.id, `${last.markdown} done`)
  } else if (pick < 0.7) {
    nodes.push(runningTool(nextId('tool')))
  } else if (pick < 0.8 && last?.kind === 'tool' && last.tool.status === 'running') {
    nodes[nodes.length - 1] = {
      ...last,
      tool: { ...last.tool, status: 'completed', completedAt: '2026-08-17T05:00:02.500Z' },
    }
  } else if (pick < 0.88) {
    nodes.push({
      kind: 'compaction',
      id: nextId('compaction'),
      compaction: { id: nextId('compaction'), phase: random() < 0.5 ? 'start' : 'end' },
    })
  } else if (pick < 0.94 && nodes.length > 0) {
    const index = Math.floor(random() * nodes.length)
    if (index === nodes.length - 1) {
      nodes[index] = runningTool(nextId('tool'))
    } else {
      nodes[index] = nonLedgerNode(nextId('notice'))
    }
  } else if (nodes.length > 2) {
    nodes.length = 1 + Math.floor(random() * (nodes.length - 1))
  } else {
    nodes.push(nonLedgerNode(nextId('notice')))
  }

  return nodes
}
