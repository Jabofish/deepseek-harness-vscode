// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { SessionStatsProjection } from '@dsh-vscode/domain'
import { StatsLine } from './StatsLine.js'
import { StatsDetails } from './StatsDetails.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { ReactElement } from 'react'
afterEach(() => {
  cleanup()
  localStorage.clear()
})
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

it('keeps focused readings stable while exclusive detail panels dismiss and return focus', () => {
  render(
    <ConversationLayoutProvider>
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
      />
    </ConversationLayoutProvider>,
  )
  const triggers = screen.getAllByRole('button', { name: /Statistics details:/ })
  fireEvent.click(triggers[0]!)
  const time = screen.getByRole('dialog', { name: 'Statistics details' })
  expect(time.closest('.dsh-stats-line')).toBeNull()
  expect(within(time).getByText('1,234 ms')).toBeDefined()
  expect(within(time).queryByText('Uncached input tokens')).toBeNull()
  expect(document.activeElement).toBe(time)
  fireEvent.click(triggers[1]!)
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  const tokens = screen.getByRole('dialog')
  expect(within(tokens).getByText('1,880')).toBeDefined()
  expect(within(tokens).queryByText('1,234 ms')).toBeNull()
  fireEvent.keyDown(tokens, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(triggers[1])
  fireEvent.click(triggers[0]!)
  fireEvent.pointerDown(document.body)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('dismisses focused details when changing sessions or switching to compact readings', () => {
  const content = (
    sessionId: string,
    performanceUsage: 'compact' | 'detailed' = 'detailed',
  ): ReactElement => (
    <ConversationLayoutProvider>
      <StatsLine
        sessionId={sessionId}
        performanceUsage={performanceUsage}
        nodes={[]}
        sessionStats={stats}
        cacheHit={0}
        usage={{ inputTokens: 10, outputTokens: 20 }}
      />
    </ConversationLayoutProvider>
  )
  const view = render(content('first'))
  fireEvent.click(screen.getAllByRole('button')[0]!)
  expect(screen.getByRole('dialog')).toBeDefined()
  view.rerender(content('second'))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getAllByRole('button')[0]!)
  view.rerender(content('second', 'compact'))
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(content('second'))
  expect(screen.queryByRole('dialog')).toBeNull()
})
