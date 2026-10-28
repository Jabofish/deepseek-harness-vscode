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

  it('uses the exact reported total and hides it when the total is unavailable', () => {
    const { rerender } = render(
      <StatsLine
        nodes={nodes}
        usage={{ inputTokens: 100, outputTokens: 10, totalTokens: 125 }}
        cacheHit={0}
      />,
    )

    expect(screen.getByText('Σ 125 tokens').getAttribute('title')).toBe('Total billed and cache tokens')

    rerender(<StatsLine nodes={nodes} usage={{ inputTokens: 100, outputTokens: 10 }} cacheHit={0} />)
    expect(screen.queryByText(/Σ/u)).toBeNull()
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
