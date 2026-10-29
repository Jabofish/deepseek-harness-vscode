// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { ReactElement } from 'react'
import { Timeline } from './Timeline.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'

afterEach(cleanup)
const source: readonly TimelineNode[] = [
  { kind: 'user-message', id: 'question', markdown: 'Keep this question' },
  ...Array.from({ length: 8 }, (_, index): TimelineNode => ({
    kind: 'tool',
    id: `t${index}`,
    tool: {
      id: `t${index}`,
      name: 'read',
      title: `Activity ${index}`,
      inputSummary: `Activity ${index}`,
      category: 'read',
      status: index === 7 ? 'running' : 'completed',
      turn: index,
      metadata: {},
    },
  })),
]

it.each(['classic', 'focused'] as const)(
  'can expand, collapse, reveal and change mode without losing source in %s',
  (layout) => {
    const view = (mode: 'compact' | 'standard', reveal = false): ReactElement => (
      <ConversationLayoutProvider initialLayout={layout}>
        <Timeline
          sessionId="s"
          nodes={source}
          streaming
          transcriptView={mode}
          {...(reveal ? { revealTarget: { nodeId: 't0', requestId: 'reveal-old' } } : {})}
        />
      </ConversationLayoutProvider>
    )
    const result = render(view('compact'))
    const foldedRows = result.container.querySelectorAll('[data-node-id]').length
    expect(screen.getByText('Keep this question')).toBeDefined()
    const showAll = screen.getByRole('button', { name: 'Show all activity' })
    expect(showAll.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(showAll)
    expect(result.container.querySelectorAll('[data-node-id]').length).toBeGreaterThan(foldedRows)
    expect(screen.getByRole('button', { name: 'Show recent activity' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show recent activity' }))
    expect(result.container.querySelectorAll('[data-node-id]').length).toBe(foldedRows)
    result.rerender(view('compact', true))
    expect(screen.getByRole('button', { name: 'Show recent activity' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Show recent activity' }))
    expect(screen.getByRole('button', { name: 'Show all activity' })).toBeDefined()
    result.rerender(view('standard'))
    expect(screen.queryByRole('button', { name: /Show all activity/ })).toBeNull()
    expect(source).toHaveLength(9)
  },
)
