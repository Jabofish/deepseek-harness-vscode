// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    readonly count: number
    readonly getItemKey: (index: number) => string | number
  }) => ({
    getTotalSize: () => count * 72,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 72,
      })),
    measureElement: () => undefined,
  }),
}))

describe('Timeline', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps a bottom-pinned conversation at the latest item when the sidebar narrows', () => {
    vi.useFakeTimers()
    let resize: ResizeObserverCallback = () => undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[{ kind: 'user-message', id: 'user-1', markdown: 'A long message' }]}
        streaming={false}
      />,
    )
    const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
    let scrollHeight = 1_000
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 })
    timeline.scrollTop = 700
    fireEvent.scroll(timeline)

    act(() => resize([resizeEntry(timeline, 420)], {} as ResizeObserver))
    scrollHeight = 1_600
    act(() => resize([resizeEntry(timeline, 240)], {} as ResizeObserver))

    expect(timeline.scrollTop).toBe(1_600)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
    act(() => {
      vi.runAllTimers()
    })
  })

  it('does not force the latest item after a resize when the user scrolled upward', () => {
    let resize: ResizeObserverCallback = () => undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[{ kind: 'user-message', id: 'user-1', markdown: 'A long message' }]}
        streaming={false}
      />,
    )
    const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
    let scrollHeight = 1_000
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 })
    act(() => resize([resizeEntry(timeline, 420)], {} as ResizeObserver))
    timeline.scrollTop = 180
    fireEvent.scroll(timeline)
    scrollHeight = 1_600

    act(() => resize([resizeEntry(timeline, 240)], {} as ResizeObserver))

    expect(timeline.scrollTop).toBe(180)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeDefined()
  })

  it('keeps long reasoning collapsed while rendering the latest response as Markdown', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        markdown: 'A long private chain that should not take over the conversation.',
        streaming: false,
      },
      {
        kind: 'assistant-message',
        id: 'assistant-1',
        markdown: '## Done\n\nThe **result** is ready.',
        streaming: false,
        timing: { stepStartTime: 1_000, firstTokenTime: 2_000, completedTime: 189_000 },
      },
    ]

    const { container } = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)

    expect(screen.getByText('Thinking')).toBeDefined()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(screen.getByRole('heading', { name: 'Done' })).toBeDefined()
    expect(screen.getByText('result')).toBeDefined()
    expect(screen.getByText('Ran for 3m 08s')).toBeDefined()
  })

  it('renders compact message actions and branches from any completed answer', () => {
    const branch = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'assistant-message', id: 'assistant-1', markdown: 'First', streaming: false, sequence: 2 },
          { kind: 'assistant-message', id: 'assistant-2', markdown: 'Latest', streaming: false, sequence: 4 },
        ]}
        streaming={false}
        onBranch={branch}
      />,
    )

    const branchButtons = screen.getAllByRole('button', { name: 'Branch into a new conversation' })
    expect(branchButtons).toHaveLength(2)
    expect(branchButtons[0]?.getAttribute('aria-disabled')).toBeNull()
    expect(branchButtons[1]?.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(branchButtons[0]!)
    fireEvent.click(branchButtons[1]!)
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[1]!)

    expect(branch).toHaveBeenCalledTimes(2)
    expect(branch).toHaveBeenNthCalledWith(1, 2)
    expect(branch).toHaveBeenNthCalledWith(2, 4)
    expect(writeText).toHaveBeenCalledWith('Latest')
  })

  it('keeps a tool call inside one assistant turn and anchors branching to the final answer', () => {
    const branch = vi.fn()
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-before',
            markdown: 'Before the tool.',
            streaming: false,
            sequence: 3,
            turn: 1,
            step: 0,
            turnCompleted: false,
          },
          {
            kind: 'tool',
            id: 'tool:call-1',
            tool: {
              id: 'call-1',
              turn: 1,
              step: 0,
              name: 'read',
              category: 'filesystem',
              title: 'Read',
              status: 'completed',
              inputSummary: 'README.md',
              outputSummary: 'file contents',
              metadata: {},
            },
          },
          {
            kind: 'assistant-message',
            id: 'assistant-after',
            markdown: 'After the tool.',
            streaming: false,
            sequence: 7,
            turn: 1,
            step: 1,
            turnCompleted: true,
          },
        ]}
        streaming={false}
        onBranch={branch}
      />,
    )

    expect(document.querySelectorAll('.dsh-timeline__card--assistant')).toHaveLength(1)
    expect(screen.getByText('Before the tool.')).toBeDefined()
    expect(screen.getByText('After the tool.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand Read details' })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Branch into a new conversation' }))
    expect(branch).toHaveBeenCalledWith(7)
  })

  it('shows a compact activity phrase instead of message actions while an answer is streaming', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: 'In progress',
            streaming: true,
            sequence: 2,
          },
        ]}
        streaming={true}
        onBranch={() => undefined}
      />,
    )

    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Branch into a new conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('keeps a settled step in activity state until the durable turn end arrives', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'assistant-message',
        id: 'assistant-1',
        markdown: 'Waiting for the turn boundary',
        streaming: false,
        sequence: 2,
        turn: 1,
        step: 0,
      },
    ]
    const view = render(
      <Timeline
        sessionId="session-1"
        nodes={nodes}
        streaming={true}
        activeTurn={1}
        onBranch={() => undefined}
      />,
    )

    expect(screen.getByRole('status')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Branch into a new conversation' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()

    view.rerender(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: 'Waiting for the turn boundary',
            streaming: false,
            sequence: 2,
            turn: 1,
            step: 0,
            turnCompleted: true,
          },
        ]}
        streaming={false}
        onBranch={() => undefined}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Branch into a new conversation' })).toBeDefined()
  })

  it('does not treat a settled answer as active when the session is idle', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: 'Completed answer',
            streaming: false,
            sequence: 4,
            turn: 1,
            step: 1,
            turnCompleted: true,
          },
        ]}
        streaming={false}
        running={false}
        activeTurn={1}
        onBranch={() => undefined}
      />,
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Branch into a new conversation' })).toBeDefined()
  })

  it('renders the aggregated retry row and compaction accounting', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'retry',
        id: 'retry:retry-1',
        turn: 1,
        step: 1,
        attempt: 3,
        state: 'scheduled',
        message: 'rate limited',
      },
      {
        kind: 'compaction',
        id: 'compaction:c1',
        compaction: {
          id: 'c1',
          phase: 'end',
          summary: 'Kept the task list.',
          replacedCount: 12,
          estimatedTokens: 8_400,
        },
      },
    ]

    render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)

    expect(screen.getByText(/Retrying \(attempt 3\)/u)).toBeDefined()
    expect(screen.getByText(/rate limited/u)).toBeDefined()
    expect(screen.getByText('12 entries · ~8.4K tokens')).toBeDefined()
  })

  it('renders text attachments as compact file items instead of Markdown bodies', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'user-message',
            id: 'user-1',
            markdown: '概括文件内容',
            attachments: [{ name: '思路4.md' }],
          },
        ]}
        streaming={false}
      />,
    )

    expect(screen.getByText('概括文件内容')).toBeDefined()
    expect(screen.getByText('思路4.md')).toBeDefined()
    expect(screen.queryByText('Attached file: 思路4.md')).toBeNull()
  })

  it('renders subagent tool details as labeled content instead of raw protocol JSON', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:call-1',
            tool: {
              id: 'call-1',
              name: 'subagent',
              category: 'tool',
              title: 'Tool',
              status: 'completed',
              inputSummary: JSON.stringify({
                description: '子代理功能演示任务',
                prompt: '列出喜欢的语言并完成计算。',
              }),
              outputSummary: JSON.stringify({
                source: { kind: 'tool', callId: 'call-secret' },
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'call-secret',
                    content: [{ type: 'text', text: 'started subagent child-secret-id' }],
                  },
                ],
                role: 'user',
              }),
              metadata: {},
            },
          },
        ]}
        streaming={false}
      />,
    )

    expect(screen.getByText('Subagent')).toBeDefined()
    expect(screen.getByText('Task · 子代理功能演示任务')).toBeDefined()
    expect(screen.getByText('Completed')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Expand Subagent details' }))
    expect(screen.getByText('Instructions')).toBeDefined()
    expect(screen.getByText('列出喜欢的语言并完成计算。')).toBeDefined()
    expect(screen.getByText('Subagent started successfully.')).toBeDefined()
    expect(screen.queryByText(/call-secret/u)).toBeNull()
    expect(screen.queryByText(/"source"/u)).toBeNull()
  })

  it('keeps producer-owned context out of the Chat surface', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'user-message',
            id: 'context-1',
            markdown: 'Injected context should only appear in Trajectory.',
            source: 'plugin',
          },
        ]}
        streaming={false}
      />,
    )

    expect(screen.queryByText('Injected context should only appear in Trajectory.')).toBeNull()
  })
})

function resizeEntry(target: Element, width: number): ResizeObserverEntry {
  return {
    target,
    contentRect: { width } as DOMRectReadOnly,
  } as ResizeObserverEntry
}
