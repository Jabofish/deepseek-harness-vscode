// @vitest-environment jsdom
import { useState, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { ConversationLayout } from '../../app/conversation-layout.js'

import { ToolCallCollection, type ToolTimelineNode } from './ToolCallCollection.js'
import { FocusedToolActivity } from './FocusedToolActivity.js'
import { Timeline } from './Timeline.js'

const t = (key: string): string => key
afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.className = ''
  vi.restoreAllMocks()
})

function tool(
  id: string,
  status: ToolTimelineNode['tool']['status'] = 'running',
  output = 'first',
): ToolTimelineNode {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      name: 'shell',
      title: output,
      category: 'execution',
      status,
      inputSummary: output,
      outputSummary: output,
      metadata: {},
    },
  }
}

function Tools(props: {
  readonly layout: ConversationLayout
  readonly tools: readonly ToolTimelineNode[]
}): ReactElement {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const input = { tools: props.tools, expanded, translate: t }
  return (
    <ConversationLayoutProvider initialLayout={props.layout}>
      {props.layout === 'focused' ? (
        <FocusedToolActivity {...input} transcriptView="detailed" onExpandedChange={setExpanded} />
      ) : (
        <ToolCallCollection {...input} onExpandedChange={setExpanded} />
      )}
    </ConversationLayoutProvider>
  )
}

it.each([false, true])(
  'keeps focus on the process summary or row when a preparing tool has no live controls (turn: %s)',
  async (hasTurn) => {
    document.body.classList.add('vscode-using-screen-reader')
    const preparing: ToolTimelineNode = {
      kind: 'tool',
      id: 'preparing',
      tool: {
        id: 'preparing',
        name: 'dynamic',
        title: 'Preparing tool',
        category: 'other',
        status: 'queued',
        metadata: {},
        preparation: { attemptId: 'attempt', updateIndex: 1 },
        ...(hasTurn ? { turn: 1, step: 0 } : {}),
      },
    }
    const view = render(
      <ConversationLayoutProvider initialLayout="focused">
        <Timeline sessionId="s" streaming running transcriptView="detailed" nodes={[preparing]} />
      </ConversationLayoutProvider>,
    )
    const quietSummary = screen.getByRole('button', { name: 'Tools working…' })
    const row = quietSummary.closest<HTMLElement>('.dsh-timeline__row')!
    quietSummary.focus()
    await act(async () => {
      document.body.classList.remove('vscode-using-screen-reader')
      await Promise.resolve()
    })
    expect(quietSummary.isConnected).toBe(false)
    expect(document.activeElement).toBe(hasTurn ? row.querySelector('.dsh-focused-turn__summary') : row)
    if (!hasTurn) expect(row.tabIndex).toBe(-1)
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await act(async () => {
      document.body.classList.add('vscode-using-screen-reader')
      await Promise.resolve()
    })
    expect(document.activeElement).toBe(outside)
    outside.remove()
    view.unmount()
  },
)

describe.each(['focused', 'classic'] as const)('%s quiet activity', (layout) => {
  it('exposes errors once without broadcasting changing failure counts or output', () => {
    document.body.classList.add('vscode-using-screen-reader')
    const view = render(<Tools layout={layout} tools={[tool('one')]} />)
    view.rerender(<Tools layout={layout} tools={[tool('one', 'failed', 'first failure'), tool('two')]} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('timeline.quietTools.failed')
    const observer = new MutationObserver(() => undefined)
    observer.observe(status, { subtree: true, childList: true, characterData: true, attributes: true })
    view.rerender(
      <Tools
        layout={layout}
        tools={[tool('one', 'failed', 'more error text'), tool('two', 'failed'), tool('three')]}
      />,
    )
    expect(observer.takeRecords()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'timeline.quietTools.running' }))
    expect(view.container.textContent).toContain('more error text')
    expect(screen.queryByText('timeline.quietTools.failed')).toBeNull()
    observer.disconnect()
  })
})
