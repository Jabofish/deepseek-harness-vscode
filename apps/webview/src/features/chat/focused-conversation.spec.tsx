// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import { ConversationLayoutControl } from '../../app/ConversationLayoutControl.js'
import { Timeline } from './Timeline.js'
import { FocusedToolActivity } from './FocusedToolActivity.js'
import type { TranscriptViewMode } from '../../app/ui-preferences.js'
import type { ReactElement } from 'react'

const nodes: readonly TimelineNode[] = [
  { kind: 'user-message', id: 'user', markdown: 'Investigate the project' },
  {
    kind: 'assistant-message',
    id: 'commentary',
    markdown: 'I am examining the implementation',
    streaming: false,
    turn: 1,
    step: 1,
    turnCompleted: true,
  },
  {
    kind: 'tool',
    id: 'tool',
    tool: {
      id: 'tool',
      name: 'read',
      title: 'Read source',
      category: 'read',
      turn: 1,
      step: 1,
      status: 'completed',
      metadata: {},
      inputSummary: 'src/example.ts',
    },
  },
  {
    kind: 'assistant-message',
    id: 'answer',
    markdown: 'The complete result',
    streaming: false,
    turn: 1,
    step: 2,
    turnCompleted: true,
    sequence: 42,
  },
]

function session(
  mode: TranscriptViewMode = 'standard',
  source = nodes,
  reveal?: string,
  requestId = 'reveal',
): ReactElement {
  return (
    <ConversationLayoutProvider initialLayout="focused">
      <ConversationLayoutControl />
      <Timeline
        sessionId="fixture"
        nodes={source}
        streaming={false}
        transcriptView={mode}
        {...(reveal === undefined ? {} : { revealTarget: { nodeId: reveal, requestId } })}
      />
    </ConversationLayoutProvider>
  )
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('focused conversation interactions', () => {
  it.each(['standard', 'compact'] as const)(
    'keeps one completed Turn usage disclosure without per-request metric rows in %s view',
    (mode) => {
      const source = nodes.map((node): TimelineNode =>
        node.kind !== 'assistant-message'
          ? node
          : {
              ...node,
              modelLabel: 'fixture-model',
              timing: { stepStartTime: 1_000, firstTokenTime: 1_500, completedTime: 2_500 },
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              ...(node.id === 'answer'
                ? { turnUsage: { inputTokens: 20, outputTokens: 40, totalTokens: 60 } }
                : {}),
            },
      )
      const view = render(session(mode, source))
      fireEvent.click(screen.getByRole('button', { name: /Work completed/u }))
      expect(screen.getByText('I am examining the implementation')).toBeDefined()
      expect(screen.getByText('The complete result')).toBeDefined()
      expect(view.container.querySelectorAll('.dsh-timeline__assistant-metrics')).toHaveLength(0)
      expect(screen.getAllByText('Token usage')).toHaveLength(1)
      fireEvent.click(screen.getByText('Token usage'))
      expect(screen.getByText('60')).toBeDefined()
      expect(screen.getByText('40')).toBeDefined()

      view.rerender(session('detailed', source))
      expect(view.container.querySelectorAll('.dsh-timeline__assistant-metrics')).toHaveLength(2)
      expect(screen.getAllByText('Token usage')).toHaveLength(1)
    },
  )

  it('does not insert request metrics while a multi-step Turn is active and preserves interruption notices', () => {
    const source = nodes.map((node): TimelineNode =>
      node.kind !== 'assistant-message'
        ? node
        : {
            ...node,
            turnCompleted: false,
            timing: { stepStartTime: 1_000, firstTokenTime: 1_500, completedTime: 2_500 },
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          },
    )
    const view = render(session('standard', source))
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    expect(screen.getByText('The complete result')).toBeDefined()
    expect(view.container.querySelectorAll('.dsh-timeline__assistant-metrics')).toHaveLength(0)
    expect(screen.queryByText('Token usage')).toBeNull()
    view.rerender(
      session(
        'standard',
        source.map((node) =>
          node.kind === 'assistant-message' ? { ...node, interrupted: true as const } : node,
        ),
      ),
    )
    expect(screen.getAllByText('Interrupted')).not.toHaveLength(0)
    expect(view.container.querySelectorAll('.dsh-timeline__assistant-metrics')).toHaveLength(0)
  })

  it('presents one disclosure across virtual segments and toggles the entire continuous process', () => {
    const source: TimelineNode[] = Array.from({ length: 55 }, (_, index) => ({
      kind: 'assistant-message',
      id: `continuous-${index}`,
      markdown: `Progress item ${index}`,
      streaming: false,
      turn: 1,
      step: index + 1,
      turnCompleted: false,
    }))
    const view = render(session('standard', source))
    expect(screen.getAllByRole('button', { name: /Work details/u })).toHaveLength(1)
    expect(screen.getByText('Progress item 54')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Work details/u }))
    expect(screen.queryByText('Progress item 0')).toBeNull()
    expect(screen.queryByText('Progress item 54')).toBeNull()
    view.rerender(
      session('standard', [
        ...source,
        {
          kind: 'assistant-message',
          id: 'continuous-answer',
          markdown: 'Final continuous answer',
          streaming: false,
          turn: 1,
          step: 56,
          turnCompleted: true,
        },
      ]),
    )
    expect(screen.getAllByRole('button', { name: /Work completed/u })).toHaveLength(1)
    expect(screen.getByText('Final continuous answer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Work completed/u }))
    expect(screen.getByText('Progress item 0')).toBeTruthy()
    expect(screen.getByText('Progress item 54')).toBeTruthy()
  })
  it('lets a user close active work, retains that choice on updates, and reopens the same process', () => {
    const live = nodes
      .slice(0, -1)
      .map((node) => (node.kind === 'assistant-message' ? { ...node, turnCompleted: false } : node))
    const view = render(session('standard', live))
    const summary = screen.getByRole<HTMLButtonElement>('button', { name: /Work details/u })
    expect(summary.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Tool calls: 1/u }))
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('I am examining the implementation')).toBeNull()

    const updated = live.map((node) =>
      node.kind === 'assistant-message' ? { ...node, markdown: 'New progress from the same Turn' } : node,
    )
    view.rerender(session('standard', updated))
    expect(screen.queryByText('New progress from the same Turn')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Work details/u }))
    expect(screen.getByText('New progress from the same Turn')).toBeDefined()
    expect(screen.getByRole('button', { name: /Tool calls: 1/u }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: /Work details/u }))
    view.rerender(session('standard', [...updated, nodes.at(-1)!]))
    expect(screen.getByRole('button', { name: /Work completed/u }).getAttribute('aria-expanded')).toBe(
      'false',
    )
    expect(screen.getByText('The complete result')).toBeDefined()
  })

  it('allows closing inspector-revealed work and reopens it for a new request to the same source', () => {
    const view = render(session('standard', nodes, 'tool'))
    const group = screen.getByRole('button', { name: /Work completed/u })
    expect(group.getAttribute('aria-expanded')).toBe('true')
    const tool = screen.getByRole('button', { name: /Collapse Read source details/u })
    fireEvent.click(tool)
    expect(tool.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(group)
    expect(group.getAttribute('aria-expanded')).toBe('false')
    view.rerender(session('standard', nodes, 'tool', 'reveal-again'))
    expect(group.getAttribute('aria-expanded')).toBe('true')
    expect(
      screen.getByRole('button', { name: /Collapse Read source details/u }).getAttribute('aria-expanded'),
    ).toBe('true')
  })

  it('keeps a failed command visible even when the host records the call as completed', () => {
    const source = nodes.map((node) =>
      node.kind === 'tool'
        ? {
            ...node,
            tool: {
              ...node.tool,
              presentation: {
                phase: 'result' as const,
                card: 'terminal' as const,
                exitCode: 1,
                output: 'The check failed',
              },
            },
          }
        : node,
    )
    render(session('standard', source))
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    expect(
      screen
        .getByRole('button', { name: /Failed tool calls: 1/u })
        .classList.contains('dsh-focused-tools__summary--failed'),
    ).toBe(true)
    expect(screen.queryByRole('button', { name: /Work completed/u })).toBeNull()
  })
  it('keeps produced file actions accessible while the original tool process is collapsed', () => {
    const open = vi.fn()
    const reveal = vi.fn()
    const source = nodes.map((node) =>
      node.kind === 'tool'
        ? { ...node, tool: { ...node.tool, category: 'edit', locations: [{ path: 'src/result.ts' }] } }
        : node,
    )
    render(
      <ConversationLayoutProvider initialLayout="focused">
        <Timeline
          sessionId="fixture"
          nodes={source}
          streaming={false}
          onOpenLink={open}
          onShowInFolder={reveal}
        />
      </ConversationLayoutProvider>,
    )
    expect(screen.queryByText('I am examining the implementation')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open src/result.ts' }))
    expect(open).toHaveBeenCalledWith('src/result.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Show in folder' }))
    expect(reveal).toHaveBeenCalledWith('src/result.ts')
  })
  it('folds completed work, keeps the final reply visible and opens the original process', () => {
    render(session())
    expect(screen.getByText('The complete result')).toBeDefined()
    expect(screen.queryByText('I am examining the implementation')).toBeNull()
    const button = screen.getByRole('button', { name: /Work completed/ })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    expect(screen.getByRole('button', { name: /Tool calls: 1/ })).toBeDefined()
  })

  it('preserves classic rendering and persists the switch across remounts', () => {
    const view = render(session())
    fireEvent.click(screen.getByRole('button', { name: /Conversation layout:/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Classic' }))
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    expect(view.container.querySelector('.dsh-timeline')?.getAttribute('data-conversation-layout')).toBe(
      'classic',
    )
    expect(screen.queryByText('Work completed')).toBeNull()
    view.unmount()
    render(
      <ConversationLayoutProvider>
        <ConversationLayoutControl />
      </ConversationLayoutProvider>,
    )
    expect(screen.getByRole('button', { name: 'Conversation layout: Classic' })).toBeDefined()
  })

  it('never automatically folds active or interrupted work, or verbose history', () => {
    for (const source of [
      nodes.map((node) => (node.kind === 'assistant-message' ? { ...node, turnCompleted: false } : node)),
      nodes.map((node) =>
        node.kind === 'assistant-message' ? { ...node, interrupted: true as const } : node,
      ),
    ]) {
      const view = render(session('standard', source))
      expect(screen.getByText('I am examining the implementation')).toBeDefined()
      expect(screen.queryByRole('button', { name: /Work completed/ })).toBeNull()
      view.unmount()
    }
    render(session('verbose'))
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    expect(screen.queryByRole('button', { name: /Work completed/ })).toBeNull()
  })

  it('reveals an original source node behind a completed process for the inspector', async () => {
    const view = render(session('standard', nodes, 'commentary'))
    expect(screen.getByText('I am examining the implementation')).toBeDefined()
    await waitFor(() => expect(view.container.querySelector('.dsh-timeline__row:focus')).not.toBeNull())
  })

  it('uses the original final sequence for branching', () => {
    const onBranch = vi.fn()
    render(
      <ConversationLayoutProvider initialLayout="focused">
        <Timeline sessionId="fixture" nodes={nodes} streaming={false} onBranch={onBranch} />
      </ConversationLayoutProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /branch/i }))
    expect(onBranch).toHaveBeenCalledWith(42)
  })

  it('separates final reasoning from the visible answer and reveals an original tool from the inspector', async () => {
    const source = nodes.map((node) =>
      node.kind === 'assistant-message' && node.id === 'answer'
        ? { ...node, reasoning: { markdown: 'Private reasoning', streaming: false } }
        : node,
    )
    const view = render(session('standard', source))
    expect(screen.getByText('The complete result')).toBeDefined()
    expect(screen.queryByText('Private reasoning')).toBeNull()
    view.rerender(session('standard', source, 'tool'))
    await waitFor(() => expect(view.container.querySelector('[data-tool-call-id="tool"]')).not.toBeNull())
    expect(screen.getAllByText('src/example.ts')).toHaveLength(2)
  })

  it('marks the parent tool group as failed and keeps errors inside its disclosure', () => {
    const tool = {
      kind: 'tool' as const,
      id: 'failed',
      tool: {
        id: 'failed',
        name: 'dynamic',
        title: 'Dynamic tool',
        category: 'other',
        status: 'failed' as const,
        turn: 1,
        step: 1,
        metadata: {},
        error: 'The operation failed\nFull diagnostic details',
      },
    }
    const view = render(
      session('standard', [
        ...nodes.slice(0, 2),
        tool,
        {
          ...tool,
          id: 'failed-2',
          tool: { ...tool.tool, id: 'failed-2', error: 'Another operation failed' },
        },
        ...nodes.slice(3),
      ]),
    )
    const summary = view.container.querySelector<HTMLButtonElement>('.dsh-focused-tools__summary')!
    expect(summary.classList.contains('dsh-focused-tools__summary--failed')).toBe(true)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(summary.getAttribute('aria-label')).toContain('Failed tool calls: 2')
    expect(screen.queryByText(/Full diagnostic details/)).toBeNull()
    expect(view.container.querySelector('.dsh-focused-tools__failure')).toBeNull()
    fireEvent.click(summary)
    const call = view.container.querySelector('[data-tool-call-id="failed"]')!
    fireEvent.click(call.querySelector('button')!)
    expect(call.textContent).toContain('Full diagnostic details')
    fireEvent.click(summary)
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/Full diagnostic details/)).toBeNull()
    expect(summary.classList.contains('dsh-focused-tools__summary--failed')).toBe(true)
    view.rerender(session('standard'))
    expect(view.container.querySelector('.dsh-focused-tools__summary--failed')).toBeNull()
  })

  it('distinguishes tool preparation from execution', () => {
    render(
      session('standard', [
        {
          kind: 'tool',
          id: 'preparing',
          tool: {
            id: 'preparing',
            name: 'dynamic',
            title: 'Preparing tool',
            category: 'other',
            metadata: {},
            status: 'queued',
            preparation: { attemptId: 'attempt', updateIndex: 1 },
          },
        },
      ]),
    )
    expect(screen.getByRole('button', { name: 'Preparing tool arguments…' })).toBeDefined()
    expect(screen.queryByText('Tool calls: 1')).toBeNull()
  })

  it('keeps every tool call in the main conversation group without manual pages', () => {
    const tools = Array.from({ length: 55 }, (_, index) => ({
      kind: 'tool' as const,
      id: `tool-${index}`,
      tool: {
        id: `tool-${index}`,
        name: `tool-${index}`,
        title: `Tool ${index}`,
        category: 'other',
        status: 'completed' as const,
        metadata: {},
      },
    }))
    const view = render(
      <FocusedToolActivity
        tools={tools}
        expanded={new Set()}
        onExpandedChange={() => undefined}
        translate={(key) => key}
        transcriptView="standard"
      />,
    )
    expect(view.container.querySelectorAll('[data-tool-call-id]').length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: /timeline.focused.tools/ }))
    expect(view.container.querySelectorAll('[data-tool-call-id]').length).toBe(55)
    expect(view.container.querySelector('[data-tool-call-id="tool-54"]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'timeline.focused.next' })).toBeNull()
  })
})
