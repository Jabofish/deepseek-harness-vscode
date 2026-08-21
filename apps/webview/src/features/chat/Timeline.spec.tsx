// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('offers the bounded older-history page and invokes the host-backed loader', () => {
    const loadOlder = vi.fn(() => Promise.resolve())
    render(
      <Timeline
        sessionId="session-1"
        nodes={[{ kind: 'user-message', id: 'user-1', markdown: 'latest' }]}
        streaming={false}
        hasMoreHistory
        onLoadOlderHistory={loadOlder}
      />,
    )

    const button = screen.getByRole('button', { name: 'Load earlier' })
    fireEvent.click(button)

    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('loads an older page when the user scrolls to the top', () => {
    const loadOlder = vi.fn(() => Promise.resolve())
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[{ kind: 'user-message', id: 'user-1', markdown: 'latest' }]}
        streaming={false}
        hasMoreHistory
        onLoadOlderHistory={loadOlder}
      />,
    )
    const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 })
    timeline.scrollTop = 0
    fireEvent.scroll(timeline)

    expect(loadOlder).toHaveBeenCalledTimes(1)
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

  it('sends feedback for the durable message id after collapsing a tool turn', () => {
    const onFeedback = vi.fn()
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-message-real-1',
            markdown: 'Before the tool.',
            streaming: false,
            turn: 1,
            step: 0,
            turnCompleted: true,
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
              metadata: {},
            },
          },
        ]}
        streaming={false}
        onFeedback={onFeedback}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    expect(onFeedback).toHaveBeenCalledWith('assistant-message-real-1', 'positive')
  })

  it('renders a specialized skill row and reveals only its visible result text', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:skill-1',
            tool: {
              id: 'call-skill-1',
              name: 'skill',
              category: 'tool',
              title: 'Tool',
              status: 'completed',
              inputSummary: JSON.stringify({ name: 'editing-cordis-compositions' }),
              outputSummary: JSON.stringify({
                source: { kind: 'tool', callId: 'call-secret' },
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'call-secret',
                    content: [
                      { type: 'text', text: '<skill_content>Use the editing workflow.</skill_content>' },
                    ],
                  },
                ],
              }),
              metadata: {},
            },
          },
        ]}
        streaming={false}
      />,
    )

    const row = document.querySelector<HTMLElement>('[data-tool="skill"]')
    expect(row?.getAttribute('data-variant')).toBe('skill')
    expect(screen.getByText('Skill')).toBeDefined()
    expect(screen.getByText('editing-cordis-compositions')).toBeDefined()
    expect(screen.queryByText('<skill_content>Use the editing workflow.</skill_content>')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Expand Skill details' }))

    expect(screen.getByText('<skill_content>Use the editing workflow.</skill_content>')).toBeDefined()
    expect(document.body.textContent).not.toContain('call-secret')
  })

  it('renders a real-shaped read card and delegates file opening to the host', () => {
    const openLink = vi.fn()
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:read-1',
            tool: {
              id: 'call-read-1',
              name: 'read',
              category: 'read',
              title: 'Read feature.ts',
              status: 'completed',
              presentation: {
                phase: 'result',
                card: 'read',
                path: 'src/feature.ts',
                offset: 11,
                lines: [{ number: 11, text: 'export const answer = 42' }],
                totalLines: 42,
                lang: 'ts',
              },
              metadata: {},
            },
          },
        ]}
        streaming={false}
        onOpenLink={openLink}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    expect(screen.getByText('11: export const answer = 42')).toBeDefined()
    fireEvent.click(screen.getByTitle('src/feature.ts'))
    expect(openLink).toHaveBeenCalledWith('src/feature.ts')
  })

  it('keeps a Host file-open refusal in a retryable modal', async () => {
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
      .mockResolvedValueOnce(undefined)
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:read-open-error',
            tool: {
              id: 'call-read-open-error',
              name: 'read',
              category: 'read',
              title: 'Read feature.ts',
              status: 'completed',
              presentation: {
                phase: 'result',
                card: 'read',
                path: 'src/feature.ts',
                offset: 11,
                lines: [{ number: 11, text: 'export const answer = 42' }],
                totalLines: 42,
                lang: 'ts',
              },
              metadata: {},
            },
          },
        ]}
        streaming={false}
        onOpenLink={openLink}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    fireEvent.click(screen.getByTitle('src/feature.ts'))
    await waitFor(() => expect(screen.getByRole('dialog')).toBeDefined())
    expect(screen.getByText('The editor refused this path.')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(openLink).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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
