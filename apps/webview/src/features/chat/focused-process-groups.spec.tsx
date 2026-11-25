// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { ReactElement } from 'react'
import { AccessibilityProvider } from '../../app/AccessibilityProvider.js'
import { rememberActivityPresentation } from '../../app/activity-presentation.js'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import type { CollapseTiming, TranscriptViewMode } from '../../app/ui-preferences.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { Icon } from '../../ui/Icon.js'
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
  revealTarget?: { readonly nodeId: string; readonly requestId: string },
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
        {...(revealTarget === undefined ? {} : { revealTarget })}
      />
    </ConversationLayoutProvider>
  )
}

const processHeaders = (): HTMLElement[] =>
  screen.queryAllByRole('button').filter((button) => button.closest('.dsh-focused-process') !== null)

afterEach(() => {
  cleanup()
  localStorage.clear()
  document.body.classList.remove('vscode-using-screen-reader')
})

describe('focused process groups (Compact / Standard)', () => {
  it.each(['quiet', 'auto'] as const)('keeps %s process summaries stable and announces failures', (mode) => {
    rememberActivityPresentation(mode)
    if (mode === 'auto') document.body.classList.add('vscode-using-screen-reader')
    const nodes = longTurn(1, 1, false)
    const running = nodes.map((node) =>
      node.kind === 'tool' ? { ...node, tool: { ...node.tool, status: 'running' as const } } : node,
    )
    const wrap = (input: readonly TimelineNode[]): ReactElement => (
      <AccessibilityProvider>{view(input, 'standard', 'completion', true)}</AccessibilityProvider>
    )
    const { rerender } = render(wrap(running))
    const header = processHeaders()[0]!
    expect(header.textContent).toBe('Work details')

    const thinking: TimelineNode = {
      kind: 'assistant-message',
      id: 'thinking-after-tool',
      markdown: '',
      reasoning: { markdown: 'More thinking', streaming: true },
      streaming: true,
      turn: 1,
      step: 2,
    }
    rerender(wrap([...running, thinking]))
    expect(processHeaders()[0]).toBe(header)
    expect(header.textContent).toBe('Work details')

    const failed = nodes.map((node) =>
      node.kind === 'tool' ? { ...node, tool: { ...node.tool, status: 'failed' as const } } : node,
    )
    rerender(wrap(failed))
    const group = header.closest<HTMLElement>('.dsh-focused-process')!
    expect(within(group).getByRole('status').textContent).toBe(
      'A tool failed. Expand tool activity for details.',
    )
    expect(header.textContent).toBe('Work details')
    fireEvent.click(header)
    expect(within(group).getByText('Read file 1')).toBeDefined()
    expect(within(group).queryByRole('status')).toBeNull()
  })

  it('shows a running turn of alternating thinking and tool steps as one live line', () => {
    render(view(longTurn(1, 6, false), 'compact', 'completion', true))
    const headers = processHeaders()
    expect(headers).toHaveLength(1)
    expect(headers[0]!.textContent).toContain('Running a tool')
  })

  it('marks a live thinking tail with the thinking icon even after tool steps', () => {
    const nodes = longTurn(1, 2, false)
    nodes.push({
      kind: 'assistant-message',
      id: 'think-live',
      markdown: '',
      reasoning: { markdown: 'Still thinking', streaming: true },
      streaming: true,
      turn: 1,
      step: 3,
    })
    render(view(nodes, 'compact', 'completion', true))
    const header = processHeaders()[0]!
    expect(header.textContent).toContain('Thinking…')
    const sparkles = renderToStaticMarkup(<Icon name="sparkles" />)
    expect(header.querySelector('svg')!.outerHTML).toBe(sparkles)
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

  it('can close a revealed group and reopen it with a fresh reveal request', () => {
    const nodes = longTurn(1, 3, true)
    const { rerender } = render(
      view(nodes, 'standard', 'completion', false, { nodeId: 'tool-1-2', requestId: 'reveal-1' }),
    )
    expect(processHeaders()[0]?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(processHeaders()[0]!)
    expect(processHeaders()[0]?.getAttribute('aria-expanded')).toBe('false')
    rerender(view(nodes, 'standard', 'completion', false, { nodeId: 'tool-1-2', requestId: 'reveal-2' }))
    expect(processHeaders()[0]?.getAttribute('aria-expanded')).toBe('true')
  })

  it('only labels the latest segment as live', () => {
    render(view(longTurn(1, 30, false), 'compact', 'completion', true))
    const headers = processHeaders()
    expect(headers.length).toBeGreaterThan(1)
    expect(headers.filter((header) => header.textContent?.includes('Running a tool'))).toHaveLength(1)
  })

  it('shows a settled process summary after a failed turn', () => {
    render(
      view(
        [
          ...longTurn(1, 2, false),
          { kind: 'turn-terminal', id: 'error-1', reason: 'error', turn: 1, sequence: 9 },
        ],
        'compact',
      ),
    )
    expect(processHeaders()).toHaveLength(1)
    expect(processHeaders()[0]!.textContent).not.toContain('Running a tool')
    expect(screen.getByText('Turn ended with an error')).toBeDefined()
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

  it('with next-input timing folds when the next user message arrives before any tool or reply', () => {
    const { rerender } = render(view(longTurn(1, 3, false), 'compact', 'next-input', true))
    const completed = longTurn(1, 3, true)
    rerender(view(completed, 'compact', 'next-input', false))
    expect(processHeaders()).toHaveLength(1)
    const newInput = longTurn(2, 0, false)
    rerender(view([...completed, ...newInput], 'compact', 'next-input', true))
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
