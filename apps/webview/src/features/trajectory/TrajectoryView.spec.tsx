// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { TrajectoryView } from './TrajectoryView.js'

const nodes: readonly TimelineNode[] = [
  { kind: 'user-message', id: 'u1', markdown: 'Fix the failing test in parser.spec.ts' },
  {
    kind: 'assistant-message',
    id: 'a1',
    markdown: 'I will inspect the test first.',
    streaming: false,
    modelLabel: 'deepseek-chat',
    usage: {
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 12,
    },
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
    kind: 'compaction',
    id: 'c1',
    compaction: { id: 'c1', phase: 'end', replacedCount: 12, estimatedTokens: 9_000 },
  },
  { kind: 'user-message', id: 'u2', markdown: 'Continue' },
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
]

function renderView(
  overrides: Partial<Parameters<typeof TrajectoryView>[0]> = {},
): ReturnType<typeof render> {
  return render(<TrajectoryView sessionId="session-1" nodes={nodes} streaming={false} {...overrides} />)
}

describe('TrajectoryView', () => {
  afterEach(() => cleanup())

  it('renders turn sections with a standalone between-turns compaction section', () => {
    renderView()
    expect(screen.getByRole('region', { name: 'Turn 1' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Between turns' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Turn 2' })).toBeDefined()
    expect(screen.getByText('6 records')).toBeDefined()
  })

  it('numbers records continuously and marks tool durations', () => {
    renderView()
    expect(screen.getAllByText('#1')).toHaveLength(1)
    expect(screen.getAllByText('#4')).toHaveLength(1)
    expect(screen.getByText('2,500 ms')).toBeDefined()
  })

  it('shows a live state instead of a duration for running rows', () => {
    renderView()
    expect(screen.getByText('running')).toBeDefined()
  })

  it('opens the inspector with usage and payload details on selection', () => {
    renderView()
    fireEvent.click(screen.getByText('I will inspect the test first.'))
    const region = screen.getByRole('region', { name: 'Record #2 details' })
    expect(region).toBeDefined()
    expect(screen.getByText('120 tk')).toBeDefined()
    expect(screen.getByText('800 tk')).toBeDefined()
    expect(screen.getByText('34 tk')).toBeDefined()
    expect(screen.getByText('Thinking')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }))
    expect(screen.queryByRole('region', { name: 'Record #2 details' })).toBeNull()
  })

  it('filters the ledger with the toolbar search', () => {
    renderView()
    const search = screen.getByRole('searchbox', { name: 'Search trajectory records' })
    fireEvent.change(search, { target: { value: 'parser' } })
    expect(screen.getByText('2 matches')).toBeDefined()
    expect(screen.queryByRole('region', { name: 'Turn 1' })).toBeNull()
    fireEvent.change(search, { target: { value: 'no-such-needle' } })
    expect(screen.getByText('0 matches')).toBeDefined()
  })

  it('shows an empty state for blank sessions', () => {
    renderView({ nodes: [] })
    expect(screen.getByText('No trajectory records yet.')).toBeDefined()
  })
})
