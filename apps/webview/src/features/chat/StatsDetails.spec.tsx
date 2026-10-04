// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { SessionStatsProjection } from '@dsh-vscode/domain'
import { StatsLine } from './StatsLine.js'
import { StatsDetails } from './StatsDetails.js'
afterEach(cleanup)
it('omits an empty statistics disclosure when no measurements are reported', () => {
  render(
    <StatsDetails
      stats={{
        turns: 1,
        steps: 1,
        llmMs: 0,
        toolMs: 0,
        ttftMs: 0,
        ttftSteps: 0,
        decodeMs: 0,
        decodeTokens: 0,
      }}
      usage={undefined}
    />,
  )
  expect(document.querySelector('details')).toBeNull()
})
const stats: SessionStatsProjection = {
  turns: 2,
  steps: 4,
  llmMs: 1234,
  toolMs: 500,
  ttftMs: 420,
  ttftSteps: 2,
  decodeMs: 1000,
  decodeTokens: 333,
}
it('shows exact authoritative timings and disjoint billing buckets in detailed mode', () => {
  render(
    <StatsLine
      nodes={[]}
      sessionStats={stats}
      cacheHit={0}
      usage={{
        inputTokens: 1234,
        outputTokens: 333,
        cacheReadTokens: 222,
        cacheWriteTokens: 111,
        totalTokens: 1880,
      }}
    />,
  )
  fireEvent.click(screen.getByText('Statistics details'))
  expect(document.querySelector('details')?.open).toBe(true)
  expect(screen.getByText('1,234 ms')).toBeDefined()
  expect(screen.getByText('210 ms')).toBeDefined()
  expect(screen.getByText('333 tk/s')).toBeDefined()
  expect(screen.getByText('Uncached input tokens')).toBeDefined()
  expect(screen.getByText('Cache write tokens')).toBeDefined()
  expect(screen.getByText('1,880')).toBeDefined()
})
it('keeps compact mode compact and omits unreported totals from detail', () => {
  const view = render(
    <StatsLine
      nodes={[]}
      sessionStats={stats}
      performanceUsage="compact"
      cacheHit={0}
      usage={{ inputTokens: 10, outputTokens: 20 }}
    />,
  )
  expect(document.querySelector('details')).toBeNull()
  view.rerender(
    <StatsLine
      nodes={[]}
      sessionStats={stats}
      performanceUsage="detailed"
      cacheHit={0}
      usage={{ inputTokens: 10, outputTokens: 20 }}
    />,
  )
  expect(screen.queryByText('Total tokens')).toBeNull()
  expect(screen.queryByText('Cache read tokens')).toBeNull()
})
