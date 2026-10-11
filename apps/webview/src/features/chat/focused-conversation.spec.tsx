// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import { ConversationLayoutControl } from '../../app/ConversationLayoutControl.js'
import { I18nProvider } from '../../i18n.js'
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

function session(mode: TranscriptViewMode = 'standard', source = nodes, reveal?: string): ReactElement {
  return (
    <ConversationLayoutProvider initialLayout="focused">
      <ConversationLayoutControl />
      <Timeline
        sessionId="fixture"
        nodes={source}
        streaming={false}
        transcriptView={mode}
        {...(reveal === undefined ? {} : { revealTarget: { nodeId: reveal, requestId: 'reveal' } })}
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
    expect(screen.getByText('Failed tool calls: 1')).toBeDefined()
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Conversation layout' }), {
      target: { value: 'classic' },
    })
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
    expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('classic')
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

  it('shows tool failure even when details are closed and distinguishes preparation from execution', () => {
    const tool = {
      kind: 'tool' as const,
      id: 'failed',
      tool: {
        id: 'failed',
        name: 'dynamic',
        title: 'Dynamic tool',
        category: 'other',
        status: 'failed' as const,
        metadata: {},
        error: 'The operation failed',
      },
    }
    const view = render(
      <I18nProvider>
        <FocusedToolActivity
          tools={[tool]}
          expanded={new Set()}
          onExpandedChange={() => undefined}
          translate={(key, params) =>
            key === 'timeline.focused.failedTools' ? `${params?.count} failed tool calls` : key
          }
          transcriptView="standard"
        />
      </I18nProvider>,
    )
    expect(screen.getByText('The operation failed')).toBeDefined()
    view.unmount()
    render(
      session('standard', [
        {
          ...tool,
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

  it('limits mounted details to one tool page and makes every call reachable', () => {
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
    expect(view.container.querySelectorAll('[data-tool-call-id]').length).toBe(20)
    fireEvent.click(screen.getByRole('button', { name: 'timeline.focused.next' }))
    expect(view.container.querySelector('[data-tool-call-id="tool-20"]')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'timeline.focused.next' }))
    expect(view.container.querySelectorAll('[data-tool-call-id]').length).toBe(15)
    expect(view.container.querySelector('[data-tool-call-id="tool-54"]')).not.toBeNull()
  })
})
