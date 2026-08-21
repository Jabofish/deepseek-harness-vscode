// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { StatsLine } from './StatsLine.js'

const nodes: readonly TimelineNode[] = [
  { kind: 'user-message', id: 'u1', markdown: 'Hello' },
  { kind: 'user-message', id: 'u2', markdown: 'Again' },
  {
    kind: 'tool',
    id: 't1',
    tool: {
      id: 't1',
      name: 'read',
      category: 'filesystem',
      title: 'Read',
      status: 'completed',
      metadata: {},
    },
  },
]

describe('StatsLine', () => {
  afterEach(() => cleanup())

  it('shows turns, steps, token totals, and cache hit', () => {
    render(
      <StatsLine
        nodes={nodes}
        usage={{
          inputTokens: 1_500,
          outputTokens: 2_400,
          cacheReadTokens: 500,
          cacheWriteTokens: 0,
        }}
        cacheHit={0.25}
      />,
    )

    expect(screen.getByText('2 turns')).toBeDefined()
    expect(screen.getByText('1 step')).toBeDefined()
    expect(screen.getByText('↑2.0K')).toBeDefined()
    expect(screen.getByText('↓2.4K')).toBeDefined()
    expect(screen.getByText('cache 25%')).toBeDefined()
  })

  it('renders a placeholder row when nothing has happened yet', () => {
    const { container } = render(<StatsLine nodes={[]} usage={undefined} cacheHit={0} />)
    expect(container.querySelector('.dsh-stats-line')).toBeDefined()
    expect(screen.queryByText(/turns/u)).toBeNull()
  })

  it('renders the authoritative DSH wall-time projection', () => {
    render(
      <StatsLine
        nodes={[]}
        usage={undefined}
        cacheHit={0}
        sessionStats={{
          turns: 1,
          steps: 1,
          llmMs: 3_800,
          toolMs: 600,
          ttftMs: 800,
          ttftSteps: 1,
          decodeMs: 3_000,
          decodeTokens: 120,
        }}
      />,
    )
    expect(screen.getByText('LLM 3.8s · Tool 0.6s')).toBeDefined()
    expect(screen.getByText('TTFT 0.8s · 40 tk/s')).toBeDefined()
  })

  it('keeps near-full cache hits below 100 percent and includes cache writes', () => {
    render(
      <StatsLine
        nodes={nodes}
        usage={{ inputTokens: 0, outputTokens: 2, cacheReadTokens: 999, cacheWriteTokens: 1 }}
        cacheHit={0}
      />,
    )

    expect(screen.getByText('cache 99.9%')).toBeDefined()
    expect(screen.getByText('↑1.0K')).toBeDefined()
  })
})
