// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { ReactElement } from 'react'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { CollapseTiming, TranscriptViewMode } from '../../app/ui-preferences.js'
import { Timeline } from './Timeline.js'

/** One turn of `steps` think-then-tool steps; `answered` appends the final reply. */
function longTurn(turn: number, steps: number, answered: boolean): TimelineNode[] {
  const nodes: TimelineNode[] = [{ kind: 'user-message', id: `user-${turn}`, markdown: `Task ${turn}` }]
  for (let step = 1; step <= steps; step++) {
    nodes.push({
      kind: 'assistant-message',
      id: `think-${turn}-${step}`,
      markdown: '',
      reasoning: { markdown: `Thinking ${turn}.${step}`, streaming: false },
      streaming: false,
      turn,
      step,
    })
    nodes.push({
      kind: 'tool',
      id: `tool-${turn}-${step}`,
      tool: {
        id: `tool-${turn}-${step}`,
        name: 'read',
        title: `Read file ${step}`,
        category: 'read',
        turn,
        step,
        status: 'completed',
        metadata: {},
        inputSummary: `src/file-${step}.ts`,
      },
    })
  }
  if (answered)
    nodes.push({
      kind: 'assistant-message',
      id: `answer-${turn}`,
      markdown: `Final answer ${turn}`,
      streaming: false,
      turn,
      step: steps + 1,
      turnCompleted: true,
    })
  return nodes
}

function view(
  nodes: readonly TimelineNode[],
  mode: TranscriptViewMode,
  collapseTiming: CollapseTiming = 'completion',
  streaming = false,
): ReactElement {
  return (
    <ConversationLayoutProvider initialLayout="focused">
      <Timeline
        sessionId="fixture"
        nodes={nodes}
        streaming={streaming}
        running={streaming}
        transcriptView={mode}
        collapseTiming={collapseTiming}
      />
    </ConversationLayoutProvider>
  )
}

const processHeaders = (): HTMLElement[] =>
  screen.queryAllByRole('button').filter((button) => button.closest('.dsh-focused-process') !== null)

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('focused process groups (Compact / Standard)', () => {
  it('shows a running turn of alternating thinking and tool steps as one live line', () => {
    render(view(longTurn(1, 6, false), 'compact', 'completion', true))
    const headers = processHeaders()
    expect(headers).toHaveLength(1)
    expect(headers[0]!.textContent).toContain('Running a tool')
    expect(screen.queryByText('Thinking 1.3')).toBeNull()
    expect(screen.queryByText('Read file 3')).toBeNull()
  })

  it('opens the run on request inside a capped body', () => {
    render(view(longTurn(1, 3, false), 'standard', 'completion', true))
    const header = processHeaders()[0]!
    expect(header.textContent).toContain('Read')
    fireEvent.click(header)
    const body = header.parentElement!.querySelector('.dsh-focused-process__body') as HTMLElement
    expect(body.hidden).toBe(false)
    expect(within(body).getByText('Read file 2')).toBeDefined()
  })

  it('keeps per-step rows in Detailed', () => {
    render(view(longTurn(1, 3, false), 'detailed', 'completion', true))
    expect(processHeaders()).toHaveLength(0)
  })
})

describe('completed turn folding', () => {
  it('folds a turn the user watched as soon as it completes', () => {
    const running = longTurn(1, 3, false)
    const { rerender } = render(view(running, 'compact', 'completion', true))
    expect(processHeaders()).toHaveLength(1)
    rerender(view(longTurn(1, 3, true), 'compact', 'completion', false))
    expect(processHeaders()).toHaveLength(0)
    expect(screen.getByText('Final answer 1')).toBeDefined()
    expect(screen.getByRole('button', { name: /Work completed/u }).getAttribute('aria-expanded')).toBe(
      'false',
    )
  })

  it('folds every virtual segment of a long answered turn, not only the one with the answer', () => {
    // 30 steps = 60 work rows, split into several bounded segments.
    render(view(longTurn(1, 30, true), 'compact'))
    expect(processHeaders()).toHaveLength(0)
    expect(document.querySelectorAll('.dsh-focused-turn__process:not([hidden])')).toHaveLength(0)
  })

  it('with next-input timing keeps the watched turn open until a newer turn starts', () => {
    const { rerender } = render(view(longTurn(1, 3, false), 'compact', 'next-input', true))
    rerender(view(longTurn(1, 3, true), 'compact', 'next-input', false))
    expect(processHeaders()).toHaveLength(1)
    rerender(view([...longTurn(1, 3, true), ...longTurn(2, 1, false)], 'compact', 'next-input', true))
    const turnOne = document.querySelector('[data-turn="1"]') as HTMLElement
    expect(turnOne.querySelector('.dsh-focused-process')).toBeNull()
  })

  it('keeps a finished turn without a final reply visible', () => {
    const toolOnly = longTurn(1, 2, false).map((node) =>
      node.kind === 'assistant-message' ? { ...node, turnCompleted: node.step === 2 } : node,
    )
    render(view(toolOnly, 'compact'))
    expect(processHeaders().length).toBeGreaterThan(0)
  })
})
