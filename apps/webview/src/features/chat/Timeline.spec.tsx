// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { ConversationEventToggle } from '../shell/ConversationEventToggle.js'
import { Timeline } from './Timeline.js'

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
    const canvas = container.querySelector<HTMLDivElement>('.dsh-timeline__canvas')!
    let scrollHeight = 1_000
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 })
    timeline.scrollTop = 700
    fireEvent.scroll(timeline)

    act(() => resize([resizeEntry(canvas, 420, 420)], {} as ResizeObserver))
    scrollHeight = 1_600
    act(() => resize([resizeEntry(canvas, 420, 240)], {} as ResizeObserver))
    act(() => {
      vi.runAllTimers()
    })

    expect(timeline.scrollTop).toBe(1_300)
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
  })

  it('shows tool activity when a live tool is present in the transcript tail', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'user-message', id: 'user-1', markdown: 'run it' },
          {
            kind: 'tool',
            id: 'tool-1',
            tool: {
              id: 'tool-1',
              name: 'shell',
              category: 'execution',
              title: 'Shell',
              status: 'running',
              metadata: {},
            },
          },
        ]}
        streaming
        running
      />,
    )

    expect(screen.getByText('Using a tool…')).toBeDefined()
  })

  it('applies the selected transcript presentation to reasoning, step metadata, and turn grouping', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        markdown: 'Private reasoning preview',
        streaming: false,
      },
      {
        kind: 'assistant-message',
        id: 'assistant-1',
        markdown: 'First answer',
        streaming: false,
        turn: 1,
        step: 1,
        turnCompleted: true,
      },
      {
        kind: 'assistant-message',
        id: 'assistant-2',
        markdown: 'Second answer',
        streaming: false,
        turn: 2,
        step: 0,
        turnCompleted: true,
      },
    ]
    const view = render(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} transcriptView="standard" />,
    )

    expect(document.querySelector('.dsh-timeline')?.getAttribute('data-transcript-view')).toBe('standard')
    expect(document.querySelectorAll('.dsh-timeline__card--assistant')).toHaveLength(2)
    expect(document.querySelector('.dsh-timeline__reasoning-preview')).not.toBeNull()

    view.rerender(<Timeline sessionId="session-1" nodes={nodes} streaming={false} transcriptView="compact" />)
    expect(document.querySelector('.dsh-timeline')?.getAttribute('data-transcript-view')).toBe('compact')
    expect(document.querySelector('.dsh-timeline__reasoning-preview')).not.toBeNull()
    expect(document.querySelector('.dsh-timeline__reasoning-summary')).toBeNull()

    view.rerender(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} transcriptView="detailed" />,
    )
    expect(screen.getByText('Turn 1 · step 1')).toBeDefined()

    view.rerender(<Timeline sessionId="session-1" nodes={nodes} streaming={false} transcriptView="verbose" />)
    expect(document.querySelectorAll('.dsh-timeline__card--assistant')).toHaveLength(3)
  })

  it('keeps completed reasoning manually inspectable in compact mode without a preview', () => {
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'reasoning',
            id: 'reasoning-compact',
            markdown: 'A completed step that can be opened on demand.',
            streaming: false,
          },
          {
            kind: 'assistant-message',
            id: 'assistant-compact',
            markdown: 'The answer is ready.',
            streaming: false,
            turn: 1,
            step: 2,
            turnCompleted: true,
          },
        ]}
        streaming={false}
        transcriptView="compact"
      />,
    )

    const toggle = screen.getByRole('button', { name: 'Show reasoning' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.dsh-timeline__reasoning-summary')).toBeNull()
    expect(container.querySelector('.dsh-timeline__reasoning-preview-content')?.textContent).toBe('')

    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: 'Hide reasoning' }).getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.dsh-timeline__reasoning-preview-content')?.textContent).toBe(
      'A completed step that can be opened on demand.',
    )
  })

  it('shows exact completed Turn usage only in detailed mode', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'assistant-message',
        id: 'assistant-usage',
        markdown: 'A completed answer.',
        streaming: false,
        turn: 3,
        turnCompleted: true,
        turnUsage: {
          inputTokens: 10,
          outputTokens: 9,
          totalTokens: 25,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
          reasoningTokens: 3,
        },
      },
    ]
    const view = render(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} performanceUsage="detailed" />,
    )

    fireEvent.click(screen.getByText('Token usage'))
    expect(screen.getByText('Uncached input tokens')).toBeDefined()
    expect(screen.getByText('10')).toBeDefined()
    expect(screen.getByText('9')).toBeDefined()
    expect(screen.getByText('25')).toBeDefined()
    expect(screen.getByText('4')).toBeDefined()
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText('3')).toBeDefined()

    view.rerender(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} performanceUsage="compact" />,
    )
    expect(screen.queryByText('Token usage')).toBeNull()

    const completedNode = nodes[0]
    if (completedNode === undefined || completedNode.kind !== 'assistant-message')
      throw new Error('The usage fixture needs an assistant message')
    view.rerender(
      <Timeline
        sessionId="session-1"
        nodes={[{ ...completedNode, turnCompleted: false }]}
        streaming={false}
        performanceUsage="detailed"
      />,
    )
    expect(screen.queryByText('Token usage')).toBeNull()
  })

  it('projects hidden session-reference context onto the preceding user turn', () => {
    const onOpenLink = vi.fn()
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'user-message',
            id: 'user-1',
            markdown: '检查 @src/index.ts 和 @Earlier debugging',
            source: 'user',
          },
          {
            kind: 'user-message',
            id: 'context-1',
            markdown: 'hidden recalled context',
            source: 'session-reference',
            sourceForm: 'recall',
            sessionReferenceLabels: ['Earlier debugging'],
          },
        ]}
        streaming={false}
        onOpenLink={onOpenLink}
      />,
    )

    expect(screen.getByText('Recalled sessions: Earlier debugging')).toBeDefined()
    expect(screen.queryByText('hidden recalled context')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'src/index.ts' }))
    expect(onOpenLink).toHaveBeenCalledWith('src/index.ts')
  })

  it('refreshes incremental activity and event facts at the hinted raw boundary', () => {
    const runningTool: TimelineNode = {
      kind: 'tool',
      id: 'tool-1',
      tool: {
        id: 'tool-1',
        name: 'shell',
        category: 'execution',
        title: 'Shell',
        status: 'running',
        metadata: {},
      },
    }
    const completedTool: TimelineNode = {
      ...runningTool,
      tool: { ...runningTool.tool, status: 'completed' },
    }
    const initialNodes: readonly TimelineNode[] = [runningTool]
    const completedNodes: readonly TimelineNode[] = [completedTool]
    const eventNodes: readonly TimelineNode[] = [
      { kind: 'event', id: 'event-1', name: 'connection.snapshot', payload: { ok: true } },
    ]
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={initialNodes} streaming running showDshEvents={false} />,
    )

    expect(screen.getByText('Using a tool…')).toBeDefined()

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={completedNodes}
        nodeChangeStart={0}
        nodeChangeBase={initialNodes}
        streaming
        running
        showDshEvents={false}
      />,
    )
    expect(screen.queryByText('Using a tool…')).toBeNull()

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={eventNodes}
        nodeChangeStart={0}
        nodeChangeBase={completedNodes}
        streaming={false}
        showDshEvents={false}
      />,
    )
    // Raw DSH events are hidden from the chat surface, so they must not
    // suppress the empty-state guidance for the user-visible timeline.
    expect(container.querySelector('.dsh-timeline__empty')).not.toBeNull()

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[]}
        nodeChangeStart={0}
        nodeChangeBase={eventNodes}
        streaming={false}
        showDshEvents={false}
      />,
    )
    expect(container.querySelector('.dsh-timeline__empty')).not.toBeNull()
  })

  it('drops count-based virtualization when the hinted history window shrinks', () => {
    const initialNodes: readonly TimelineNode[] = Array.from({ length: 24 }, (_, index) => ({
      kind: 'user-message' as const,
      id: `user-${index}`,
      markdown: `message ${index}`,
    }))
    const shortenedNodes = initialNodes.slice(0, 1)
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={initialNodes} streaming={false} />,
    )

    expect(
      container
        .querySelector('.dsh-timeline__canvas')
        ?.classList.contains('dsh-timeline__canvas--virtualized'),
    ).toBe(true)

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={shortenedNodes}
        nodeChangeStart={1}
        nodeChangeBase={initialNodes}
        streaming={false}
      />,
    )

    expect(
      container
        .querySelector('.dsh-timeline__canvas')
        ?.classList.contains('dsh-timeline__canvas--virtualized'),
    ).toBe(false)
  })

  it('keeps a long conversation visible before the virtualizer has a viewport rect', () => {
    const nodes: readonly TimelineNode[] = Array.from({ length: 24 }, (_, index) => ({
      kind: 'user-message' as const,
      id: `user-${index}`,
      markdown: `message ${index}`,
    }))

    const { container } = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)

    expect(container.querySelectorAll('.dsh-timeline__row').length).toBeGreaterThan(0)
  })

  it('keeps keyboard focus on a row action when scrolling it outside the virtual window', () => {
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.classList.contains('dsh-timeline')) return 200
        if (this.classList.contains('dsh-timeline__row')) return 96
        return 0
      },
    })
    const nodes: readonly TimelineNode[] = Array.from({ length: 48 }, (_, index) => ({
      kind: 'assistant-message' as const,
      id: `assistant-${index}`,
      markdown: `Answer ${index}`,
      streaming: false,
    }))
    const view = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)
    try {
      const { container } = view
      const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
      Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(timeline, 'offsetWidth', { configurable: true, value: 500 })
      Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 4_800 })

      expect(
        container
          .querySelector('.dsh-timeline__canvas')
          ?.classList.contains('dsh-timeline__canvas--virtualized-ready'),
      ).toBe(true)
      const firstVisibleRow = container.querySelector<HTMLElement>('.dsh-timeline__row[data-index="0"]')
      expect(firstVisibleRow).not.toBeNull()
      const copyButton = within(firstVisibleRow!).getByRole('button', { name: 'Copy' })
      copyButton.focus()
      expect(document.activeElement).toBe(copyButton)

      fireEvent.wheel(timeline, { deltaY: -120 })
      view.rerender(
        <Timeline
          sessionId="session-1"
          nodes={[{ kind: 'user-message', id: 'older-user', markdown: 'Earlier message' }, ...nodes]}
          streaming={false}
        />,
      )
      expect(document.activeElement).toBe(copyButton)
      expect(copyButton.closest<HTMLElement>('.dsh-timeline__row')?.dataset.nodeId).toBe('assistant-0')

      fireEvent.wheel(timeline, { deltaY: 120 })
      timeline.scrollTop = 2_400
      fireEvent.scroll(timeline)

      expect(container.querySelector('.dsh-timeline__row[data-index="24"]')).not.toBeNull()
      expect(
        container.querySelector('.dsh-timeline__row[data-node-id="assistant-0"][data-index="1"]'),
      ).not.toBeNull()
      expect(document.activeElement).toBe(copyButton)
      expect(copyButton.isConnected).toBe(true)
    } finally {
      view.unmount()
      if (offsetHeightDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor)
    }
  })

  it('exposes a keyboard-scrollable named region and preserves row-control key behavior', () => {
    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.classList.contains('dsh-timeline')) return 200
        if (this.classList.contains('dsh-timeline__row')) return 96
        return 0
      },
    })
    const nodes: readonly TimelineNode[] = Array.from({ length: 48 }, (_, index) => ({
      kind: 'assistant-message' as const,
      id: `assistant-${index}`,
      markdown: `Answer ${index}`,
      streaming: false,
    }))
    const view = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)
    try {
      const { container } = view
      const timeline = screen.getByRole('region', { name: 'Conversation timeline' })
      Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 200 })
      Object.defineProperty(timeline, 'offsetWidth', { configurable: true, value: 500 })
      Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 4_800 })
      let scrollTop = 300
      const scrollRequests: number[] = []
      Object.defineProperty(timeline, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (next: number) => {
          scrollTop = next
          scrollRequests.push(next)
        },
      })
      timeline.style.lineHeight = '20px'

      expect(timeline.tabIndex).toBe(0)
      expect(
        container
          .querySelector('.dsh-timeline__canvas')
          ?.classList.contains('dsh-timeline__canvas--virtualized-ready'),
      ).toBe(true)
      const initialIndexes = Array.from(
        container.querySelectorAll<HTMLElement>('.dsh-timeline__row'),
        (row) => row.dataset.index,
      )
      timeline.focus()
      expect(document.activeElement).toBe(timeline)

      const scrollWithKey = (key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          ...modifiers,
        })
        fireEvent(timeline, event)
        fireEvent.scroll(timeline)
        expect(document.activeElement).toBe(timeline)
        return event
      }

      expect(scrollWithKey('ArrowDown').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(320)
      expect(scrollWithKey('ArrowUp').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(300)

      expect(scrollWithKey('PageDown').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(500)
      expect(timeline.dataset.scrollFollow).toBe('free')
      const pageDownIndexes = Array.from(
        container.querySelectorAll<HTMLElement>('.dsh-timeline__row'),
        (row) => row.dataset.index,
      )
      expect(pageDownIndexes).not.toEqual(initialIndexes)
      expect(scrollWithKey('PageUp').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(300)

      expect(scrollWithKey(' ').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(500)
      expect(scrollWithKey(' ', { shiftKey: true }).defaultPrevented).toBe(true)
      expect(scrollTop).toBe(300)

      expect(scrollWithKey('Home').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(0)
      expect(scrollWithKey('ArrowUp').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(0)
      expect(scrollWithKey('End').defaultPrevented).toBe(true)
      expect(scrollTop).toBe(4_600)
      expect(scrollWithKey(' ', { shiftKey: true }).defaultPrevented).toBe(true)
      expect(scrollTop).toBe(4_400)
      expect(scrollRequests).toContain(4_600)

      expect(scrollWithKey('Home', { ctrlKey: true }).defaultPrevented).toBe(false)
      expect(scrollTop).toBe(4_400)

      expect(scrollWithKey('Home').defaultPrevented).toBe(true)
      const firstRow = container.querySelector<HTMLElement>('.dsh-timeline__row[data-index="0"]')
      expect(firstRow).not.toBeNull()
      const copyButton = within(firstRow!).getByRole('button', { name: 'Copy' })
      copyButton.focus()
      const beforeControlKey = scrollTop
      for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End']) {
        const controlKey = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
        })
        fireEvent(copyButton, controlKey)
        expect(controlKey.defaultPrevented).toBe(false)
        expect(scrollTop).toBe(beforeControlKey)
        expect(document.activeElement).toBe(copyButton)
      }
    } finally {
      view.unmount()
      if (offsetHeightDescriptor === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
      else Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeightDescriptor)
    }
  })

  it('does not reset the reader position when virtualization is enabled after a short history', () => {
    vi.useFakeTimers()
    const initialNodes: readonly TimelineNode[] = [{ kind: 'user-message', id: 'user-0', markdown: 'first' }]
    const longNodes: readonly TimelineNode[] = Array.from({ length: 24 }, (_, index) => ({
      kind: 'user-message' as const,
      id: `user-${index}`,
      markdown: `message ${index}`,
    }))
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={initialNodes} streaming={false} />,
    )
    const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
    let scrollTop = 0
    let writes = 0
    Object.defineProperty(timeline, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        writes += 1
        scrollTop = value
      },
    })
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 2_000 })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 400 })
    fireEvent.wheel(timeline, { deltaY: -30 })
    timeline.scrollTop = 640
    fireEvent.scroll(timeline)

    rerender(<Timeline sessionId="session-1" nodes={longNodes} streaming={false} />)

    expect(timeline.scrollTop).toBe(640)
    expect(writes).toBe(1)
  })

  it('restores a middle reader position when a long timeline layout clamps to the top', () => {
    vi.useFakeTimers()
    const nodes: readonly TimelineNode[] = [
      ...Array.from({ length: 23 }, (_, index) => ({
        kind: 'user-message' as const,
        id: `user-${index}`,
        markdown: `message ${index}`,
      })),
      { kind: 'assistant-message', id: 'assistant-23', markdown: 'answer', streaming: true },
    ]
    const updatedNodes = nodes.map((node, index) =>
      index === nodes.length - 1 && node.kind === 'assistant-message'
        ? { ...node, markdown: `${node.markdown} updated` }
        : node,
    )
    const { container, rerender } = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)
    const timeline = container.querySelector<HTMLDivElement>('.dsh-timeline')!
    let scrollTop = 640
    Object.defineProperty(timeline, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 2_000 })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 400 })
    fireEvent.wheel(timeline, { deltaY: -30 })
    fireEvent.scroll(timeline)

    // Simulate the browser clamp that can happen while the virtualized canvas
    // is replaced. The next streamed update must restore the middle position.
    timeline.scrollTop = 0
    rerender(<Timeline sessionId="session-1" nodes={updatedNodes} streaming={false} />)

    expect(timeline.scrollTop).toBe(640)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeDefined()
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

  it('keeps older-history requests scoped to the session when an earlier request settles late', async () => {
    let finishFirst!: () => void
    let finishSecond!: () => void
    const loadFirst = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    const loadSecond = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve
        }),
    )
    const view = render(
      <Timeline
        sessionId="session-first"
        nodes={[{ kind: 'user-message', id: 'first', markdown: 'first' }]}
        streaming={false}
        hasMoreHistory
        onLoadOlderHistory={loadFirst}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(loadFirst).toHaveBeenCalledOnce()

    view.rerender(
      <Timeline
        sessionId="session-second"
        nodes={[{ kind: 'user-message', id: 'second', markdown: 'second' }]}
        streaming={false}
        hasMoreHistory
        onLoadOlderHistory={loadSecond}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(loadSecond).toHaveBeenCalledOnce()

    await act(async () => {
      finishFirst()
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(loadSecond).toHaveBeenCalledOnce()

    await act(async () => {
      finishSecond()
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(loadSecond).toHaveBeenCalledTimes(2)
  })

  it('keeps memoized row actions wired to the latest parent callback', () => {
    const nodes = [
      {
        kind: 'assistant-message' as const,
        id: 'assistant-1',
        markdown: 'answer',
        streaming: false,
      },
    ]
    const firstFeedback = vi.fn()
    const latestFeedback = vi.fn()
    const view = render(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} onFeedback={firstFeedback} />,
    )

    view.rerender(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} onFeedback={latestFeedback} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))

    expect(firstFeedback).not.toHaveBeenCalled()
    expect(latestFeedback).toHaveBeenCalledWith('assistant-1', 'positive')
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
    fireEvent.wheel(timeline, { deltaY: -30 })
    fireEvent.scroll(timeline)

    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('does not load older history when layout temporarily clamps a pinned reader to the top', () => {
    vi.useFakeTimers()
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
    let scrollTop = 600
    Object.defineProperty(timeline, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 400 })

    // Simulate the browser's transient clamp while the content layout is
    // being replaced. It must not be mistaken for a request to load history.
    timeline.scrollTop = 0
    fireEvent.scroll(timeline)
    act(() => {
      vi.runAllTimers()
    })

    expect(loadOlder).not.toHaveBeenCalled()
    expect(timeline.scrollTop).toBe(600)
  })

  it('keeps the DSH event visibility control in conversation chrome, outside the scroll owner', () => {
    const onPressedChange = vi.fn()
    const { container } = render(
      <>
        <Timeline
          sessionId="session-1"
          nodes={[{ kind: 'event', id: 'event-1', name: 'connection.snapshot', payload: { ok: true } }]}
          streaming={false}
          showDshEvents={false}
        />
        <ConversationEventToggle count={1} pressed={false} onPressedChange={onPressedChange} />
      </>,
    )

    const timeline = container.querySelector('.dsh-timeline')!
    expect(timeline.querySelector('.dsh-conversation__events-toggle')).toBeNull()
    expect(container.querySelector('.dsh-timeline__toolbar')).toBeNull()

    const toggle = screen.getByRole('button', { name: 'Show DSH events' })
    fireEvent.click(toggle)
    expect(onPressedChange).toHaveBeenCalledWith(true)
  })

  it('keeps unreadable DSH frames out of the default transcript', () => {
    const nodes: readonly TimelineNode[] = [
      { kind: 'user-message', id: 'user-1', markdown: 'Please continue' },
      { kind: 'event', id: 'event-1', name: 'agent/inbox/spliced', payload: { count: 2 } },
      { kind: 'assistant-message', id: 'assistant-1', markdown: 'Continuing.', streaming: false },
    ]
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} showDshEvents={false} />,
    )

    expect(screen.getByText('Please continue')).toBeDefined()
    expect(screen.getByText('Continuing.')).toBeDefined()
    expect(container.querySelectorAll('.dsh-timeline__event-group')).toHaveLength(0)
    expect(screen.queryByText('agent/inbox/spliced')).toBeNull()

    rerender(<Timeline sessionId="session-1" nodes={nodes} streaming={false} showDshEvents />)

    expect(container.querySelectorAll('.dsh-timeline__event-group-item')).toHaveLength(1)
    expect(screen.getByText('agent/inbox/spliced')).toBeDefined()
  })

  it('uses a labeled event action in the conversation tools menu', () => {
    render(<ConversationEventToggle count={2} pressed={false} onPressedChange={() => undefined} />)

    expect(screen.getByText('Show DSH events')).toBeDefined()
    expect(screen.getByText('(2)')).toBeDefined()
  })

  it('groups adjacent DSH events without duplicating the group card', () => {
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'event', id: 'event-1', name: 'first', payload: { index: 1 } },
          { kind: 'event', id: 'event-2', name: 'second', payload: { index: 2 } },
          { kind: 'event', id: 'event-3', name: 'third', payload: { index: 3 } },
        ]}
        streaming={false}
        showDshEvents
      />,
    )

    expect(container.querySelectorAll('.dsh-timeline__event-group')).toHaveLength(1)
    expect(container.querySelectorAll('.dsh-timeline__event-group-item')).toHaveLength(3)
  })

  it('reuses formatted payloads for existing event rows as the group grows', () => {
    const toJSON = vi.fn(() => ({ ok: true }))
    const payload = { toJSON }
    const firstEvent: TimelineNode = {
      kind: 'event',
      id: 'event-1',
      name: 'first',
      payload,
    }
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={[firstEvent]} streaming={false} showDshEvents />,
    )

    expect(toJSON).toHaveBeenCalledTimes(1)
    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[firstEvent, { kind: 'event', id: 'event-2', name: 'second', payload: { ok: true } }]}
        streaming={false}
        showDshEvents
      />,
    )

    expect(container.querySelectorAll('.dsh-timeline__event-group-item')).toHaveLength(2)
    expect(toJSON).toHaveBeenCalledTimes(1)
  })

  it('reuses an event prefix while an assistant response streams after it', () => {
    const toJSON = vi.fn(() => ({ ok: true }))
    const payload = { toJSON }
    const event: TimelineNode = { kind: 'event', id: 'event-1', name: 'first', payload }
    const assistant: TimelineNode = {
      kind: 'assistant-message',
      id: 'assistant-1',
      markdown: 'a',
      streaming: true,
    }
    const { container, rerender } = render(
      <Timeline sessionId="session-1" nodes={[event, assistant]} streaming showDshEvents />,
    )

    expect(container.querySelectorAll('.dsh-timeline__event-group-item')).toHaveLength(1)
    expect(toJSON).toHaveBeenCalledTimes(1)
    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[event, { ...assistant, markdown: 'answer' }]}
        streaming
        showDshEvents
      />,
    )

    expect(container.querySelectorAll('.dsh-timeline__event-group-item')).toHaveLength(1)
    expect(toJSON).toHaveBeenCalledTimes(1)
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
    const canvas = container.querySelector<HTMLDivElement>('.dsh-timeline__canvas')!
    let scrollHeight = 1_000
    Object.defineProperty(timeline, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(timeline, 'clientHeight', { configurable: true, value: 300 })
    act(() => resize([resizeEntry(canvas, 420, 420)], {} as ResizeObserver))
    fireEvent.wheel(timeline, { deltaY: -24 })
    timeline.scrollTop = 180
    fireEvent.scroll(timeline)
    scrollHeight = 1_600

    act(() => resize([resizeEntry(canvas, 420, 240)], {} as ResizeObserver))

    expect(timeline.scrollTop).toBe(180)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeDefined()
  })

  it('does not snap a reader back after a small intentional scroll away from the tail', () => {
    vi.useFakeTimers()
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

    fireEvent.wheel(timeline, { deltaY: -24 })
    timeline.scrollTop = 676
    fireEvent.scroll(timeline)
    scrollHeight = 1_200
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(timeline.scrollTop).toBe(676)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeDefined()
  })

  it('animates only an appended tail row, never the initial, prepended, or switched collection', () => {
    const { container, rerender } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'user-message', id: 'user-1', markdown: 'first' },
          { kind: 'assistant-message', id: 'assistant-1', markdown: 'answer', streaming: false },
        ]}
        streaming={false}
      />,
    )

    expect(container.querySelectorAll('.dsh-timeline__row--enter')).toHaveLength(0)
    const firstContent = container.querySelector('.dsh-timeline__content')

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'user-message', id: 'user-0', markdown: 'older' },
          { kind: 'user-message', id: 'user-1', markdown: 'first' },
          { kind: 'assistant-message', id: 'assistant-1', markdown: 'answer', streaming: false },
        ]}
        streaming={false}
      />,
    )
    expect(container.querySelectorAll('.dsh-timeline__row--enter')).toHaveLength(0)

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'user-message', id: 'user-0', markdown: 'older' },
          { kind: 'user-message', id: 'user-1', markdown: 'first' },
          { kind: 'assistant-message', id: 'assistant-1', markdown: 'answer', streaming: false },
          { kind: 'assistant-message', id: 'assistant-2', markdown: 'new answer', streaming: false },
        ]}
        streaming={false}
      />,
    )
    expect(container.querySelectorAll('.dsh-timeline__row--enter')).toHaveLength(1)
    expect(screen.getByText('new answer')).toBeDefined()

    rerender(
      <Timeline
        sessionId="session-2"
        nodes={[{ kind: 'assistant-message', id: 'assistant-3', markdown: 'switched', streaming: false }]}
        streaming={false}
      />,
    )
    expect(container.querySelector('.dsh-timeline__content')).not.toBe(firstContent)
    expect(
      container
        .querySelector('.dsh-timeline__content')
        ?.classList.contains('dsh-timeline__content--session-enter'),
    ).toBe(true)
    expect(container.querySelectorAll('.dsh-timeline__row--enter')).toHaveLength(0)
  })

  it('keeps completed reasoning collapsed until the reader opens it', () => {
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

    const reasoningToggle = screen.getByRole('button', { name: 'Show reasoning' })
    const collapsedContent = container.querySelector<HTMLElement>('.dsh-timeline__reasoning-preview-content')
    expect(collapsedContent).not.toBeNull()
    expect(collapsedContent?.textContent).toBe('')
    expect(collapsedContent?.getAttribute('aria-hidden')).toBe('true')
    expect(collapsedContent?.parentElement?.parentElement?.getAttribute('data-open')).toBe('false')
    expect(screen.getByRole('heading', { name: 'Done' })).toBeDefined()
    expect(screen.getByText('result')).toBeDefined()
    expect(screen.queryByText('Ran for 3m 08s')).toBeNull()

    fireEvent.click(reasoningToggle)
    expect(container.querySelector('.dsh-timeline__reasoning-preview-content')?.textContent).toBe(
      'A long private chain that should not take over the conversation.',
    )
    expect(screen.getByRole('button', { name: 'Hide reasoning' })).toBeDefined()
  })

  it('previews only the latest three reasoning lines while streaming', () => {
    const { container, rerender } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: 'The answer is ready.',
            streaming: true,
            reasoning: {
              markdown: 'old line\nlatest one\nlatest two\nlatest three',
              streaming: true,
            },
          },
        ]}
        streaming
      />,
    )

    const preview = container.querySelector<HTMLElement>('.dsh-timeline__reasoning-preview-content')
    expect(preview?.textContent).toBe('latest one\nlatest two\nlatest three')
    expect(preview?.textContent).not.toContain('old line')
    const answer = screen.getByText('The answer is ready.')
    expect(answer.compareDocumentPosition(preview!)).toBe(Node.DOCUMENT_POSITION_PRECEDING)

    rerender(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: 'The answer is ready.',
            streaming: false,
            reasoning: {
              markdown: 'old line\nlatest one\nlatest two\nlatest three',
              streaming: false,
            },
          },
        ]}
        streaming={false}
      />,
    )

    expect(container.querySelector('.dsh-timeline__reasoning-preview-content')?.textContent).toBe('')
    expect(
      container.querySelector('.dsh-timeline__reasoning-preview-content')?.getAttribute('aria-hidden'),
    ).toBe('true')
  })

  it('renders the structured terminal failure beside the generic turn label', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'turn-terminal',
            id: 'turn-terminal:1',
            turn: 1,
            sequence: 3,
            reason: 'error',
            failure: { code: 'PROVIDER_UNAVAILABLE', message: 'The provider is unavailable.' },
          },
        ]}
        streaming={false}
      />,
    )

    expect(screen.getByText('Turn ended with an error')).toBeDefined()
    expect(screen.getByText('PROVIDER_UNAVAILABLE')).toBeDefined()
    expect(screen.getByText('The provider is unavailable.')).toBeDefined()
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
    const tool = screen.getByRole('button', { name: 'Expand Read details' })
    expect(tool).toBeDefined()
    expect(screen.getByText('Before the tool.').compareDocumentPosition(tool)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(tool.compareDocumentPosition(screen.getByText('After the tool.'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Branch into a new conversation' }))
    expect(branch).toHaveBeenCalledWith(7)
  })

  it('renders reasoning first while preserving the tool position inside one assistant answer', () => {
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-before',
            markdown: 'Before the tools.',
            streaming: false,
            turn: 1,
            step: 0,
            turnCompleted: false,
          },
          {
            kind: 'reasoning',
            id: 'reasoning-1',
            markdown: 'First understand the request.',
            streaming: false,
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
              inputSummary: 'one',
              metadata: {},
            },
          },
          {
            kind: 'tool',
            id: 'tool:call-2',
            tool: {
              id: 'call-2',
              turn: 1,
              step: 0,
              name: 'search',
              category: 'filesystem',
              title: 'Search',
              status: 'completed',
              inputSummary: 'two',
              metadata: {},
            },
          },
          {
            kind: 'assistant-message',
            id: 'assistant-after',
            markdown: 'After the tools.',
            streaming: false,
            turn: 1,
            step: 1,
            turnCompleted: true,
          },
        ]}
        streaming={false}
      />,
    )

    expect(document.querySelectorAll('.dsh-timeline__card--assistant')).toHaveLength(1)
    const reasoning = screen.getByRole('button', { name: 'Show reasoning' })
    const before = screen.getByText('Before the tools.')
    const tools = container.querySelector<HTMLElement>('summary[aria-label="Show 2 tool calls"]')
    const after = screen.getByText('After the tools.')
    expect(tools).not.toBeNull()
    expect(reasoning.compareDocumentPosition(before)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(before.compareDocumentPosition(tools!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(tools!.compareDocumentPosition(after)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('does not merge a later turn into the completed answer before it', () => {
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-turn-1',
            markdown: 'First answer',
            streaming: false,
            turn: 1,
            step: 0,
            turnCompleted: true,
          },
          {
            kind: 'tool',
            id: 'tool:turn-2',
            tool: {
              id: 'call-turn-2',
              turn: 2,
              step: 0,
              name: 'read',
              category: 'filesystem',
              title: 'Read',
              status: 'completed',
              inputSummary: 'next.json',
              metadata: {},
            },
          },
          {
            kind: 'assistant-message',
            id: 'assistant-turn-2',
            markdown: 'Second answer',
            streaming: false,
            turn: 2,
            step: 1,
            turnCompleted: true,
          },
        ]}
        streaming={false}
      />,
    )

    expect(container.querySelectorAll('.dsh-timeline__card--assistant')).toHaveLength(2)
    expect(screen.getByText('First answer')).toBeDefined()
    expect(screen.getByText('Second answer')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand Read details' })).toBeDefined()
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

  it('closes only the feedback dialog when Escape lands on a message action above the refusal modal', async () => {
    const onFeedbackSubmit = vi.fn()
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'assistant-message',
            id: 'assistant-message-feedback-stack',
            markdown: 'Before the tool.',
            streaming: false,
            turn: 1,
            step: 0,
            turnCompleted: true,
          },
          {
            kind: 'tool',
            id: 'tool:read-feedback-stack',
            tool: {
              id: 'call-read-feedback-stack',
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
        onFeedbackSubmit={onFeedbackSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    fireEvent.click(screen.getByTitle('src/feature.ts'))
    await screen.findByRole('dialog', { name: 'Unable to open tool output' })

    // The refusal modal declares `aria-modal` but owns no focus trap, so the
    // keyboard can still reach a message action behind it; the feedback dialog
    // is then the innermost surface.
    fireEvent.click(screen.getByRole('button', { name: 'Good response' }))
    await screen.findByRole('dialog', { name: 'Submit feedback' })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Submit feedback' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Unable to open tool output' })).toBeDefined()
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

  it('renders explicitly delivered files with open and reveal actions', () => {
    const openLink = vi.fn()
    const showInFolder = vi.fn()
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'deliverables',
            id: 'deliverables:call-present',
            sequence: 4,
            turn: 1,
            callId: 'call-present',
            files: [{ path: 'artifacts/report.txt', description: 'Generated report' }],
          },
        ]}
        streaming={false}
        onOpenLink={openLink}
        onShowInFolder={showInFolder}
      />,
    )

    expect(screen.getByRole('region', { name: 'Files ready to open' })).toBeDefined()
    expect(screen.getByText('Generated report')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open delivered file report.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show delivered file report.txt in folder' }))
    expect(openLink).toHaveBeenCalledWith('artifacts/report.txt')
    expect(showInFolder).toHaveBeenCalledWith('artifacts/report.txt')
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

  it('returns focus to the tool link after the Host file-open refusal closes', async () => {
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:read-open-focus',
            tool: {
              id: 'call-read-open-focus',
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
    const trigger = screen.getByTitle('src/feature.ts')
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    // The modal takes the keyboard in the commit that inserts it: an outside
    // click or an Escape must not be able to land behind it.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Dismiss error' }))

    // The modal is `aria-modal`, so the keyboard has to come back to the link
    // the user was on — the timeline can recycle that row while it is up.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('returns focus to the tool link after a second refusal, not to the retry control', async () => {
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first refusal'))
      .mockRejectedValueOnce(new Error('second refusal'))
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:read-open-retry-focus',
            tool: {
              id: 'call-read-open-retry-focus',
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
    const trigger = screen.getByTitle('src/feature.ts')
    fireEvent.click(trigger)
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('second refusal')).toBeDefined())

    // The retry remounts the dialog; the row control that started the open is
    // still the element the keyboard belongs to once the refusal is dismissed.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps the keyboard on the control the user chose when the timeline re-renders under the modal', async () => {
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
    const node: TimelineNode = {
      kind: 'tool',
      id: 'tool:read-open-rerender',
      tool: {
        id: 'call-read-open-rerender',
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
    }
    const view = render(
      <Timeline sessionId="session-1" nodes={[node]} streaming={false} onOpenLink={openLink} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    fireEvent.click(screen.getByTitle('src/feature.ts'))
    const dialog = await screen.findByRole('dialog')
    const retry = within(dialog).getByRole('button', { name: 'Retry' })
    retry.focus()
    expect(document.activeElement).toBe(retry)

    // The agent keeps streaming behind the modal, so the timeline re-renders
    // while it is up. The dialog's own focus handling belongs to its mount:
    // re-running it would drag the keyboard off whatever the user had reached.
    view.rerender(<Timeline sessionId="session-1" nodes={[node]} streaming={true} onOpenLink={openLink} />)

    expect(document.activeElement).toBe(retry)
  })

  it('keeps the refusal modal when a nested surface already consumed the Escape key', async () => {
    const consumed = vi.fn()
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
    render(
      // Models the composer's slash menu and the other React-level Escape
      // consumers: their handler runs at the root container, before the window
      // listener the refusal modal owns, and marks the key as consumed.
      <div
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          consumed()
          event.preventDefault()
        }}
      >
        <Timeline
          sessionId="session-1"
          nodes={[
            {
              kind: 'tool',
              id: 'tool:read-open-consumed',
              tool: {
                id: 'call-read-open-consumed',
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
        />
      </div>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    fireEvent.click(screen.getByTitle('src/feature.ts'))
    await screen.findByRole('dialog')

    fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss error' }), { key: 'Escape' })

    expect(consumed).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('leaves the refusal modal unmounted while a retry the Host has not answered yet is in flight', async () => {
    // Falsified hypothesis: Escape could tear down the modal during an
    // in-flight retry. The retry itself clears the refusal, so there is no
    // surface for Escape to dismiss; the failure comes back with the second
    // message and the keyboard still dismisses that one.
    let settle: (() => void) | undefined
    const openLink = vi
      .fn<(_: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('The editor refused this path.'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            settle = () => reject(new Error('second refusal'))
          }),
      )
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'tool',
            id: 'tool:read-open-busy',
            tool: {
              id: 'call-read-open-busy',
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
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    await act(async () => {
      settle?.()
      await Promise.resolve()
    })
    expect(screen.getByText('second refusal')).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
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
            markdown: 'Injected context should not appear as a chat bubble.',
            source: 'plugin',
          },
        ]}
        streaming={false}
      />,
    )

    expect(screen.queryByText('Injected context should not appear as a chat bubble.')).toBeNull()
  })

  it('labels Agent Team activity states instead of printing the protocol values', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'team',
            id: 'team:member:team-1:member-1',
            activity: {
              kind: 'member',
              id: 'team:member:team-1:member-1',
              teamId: 'team-1',
              memberId: 'member-1',
              name: 'Planner',
              phase: 'provisioning',
            },
          },
          {
            kind: 'team',
            id: 'team:task:team-1:task-1',
            activity: {
              kind: 'task',
              id: 'team:task:team-1:task-1',
              teamId: 'team-1',
              taskId: 'task-1',
              subject: 'Inspect the contract',
              status: 'in_progress',
              blockedByCount: 0,
              writeScopeCount: 1,
            },
          },
          {
            kind: 'team',
            id: 'team:message:queued:team-1:message-1',
            activity: {
              kind: 'message.queued',
              id: 'team:message:queued:team-1:message-1',
              teamId: 'team-1',
              messageId: 'message-1',
              senderName: 'Planner',
              targetId: 'member-2',
              delivery: 'wakeup',
              content: 'Take the next task',
            },
          },
        ]}
        streaming={false}
      />,
    )

    // `provisioning`, `in_progress` and `wakeup` are wire identifiers, not
    // labels: rendering them verbatim puts the raw protocol value (and an
    // English-only string) into both interfaces.
    expect(screen.queryByText('provisioning')).toBeNull()
    expect(screen.queryByText('in_progress')).toBeNull()
    expect(screen.queryByText('wakeup')).toBeNull()
    expect(screen.getByText('Provisioning')).toBeDefined()
    expect(screen.getByText('In progress')).toBeDefined()
    expect(screen.getByText('Queued')).toBeDefined()
    expect(screen.getByText('Wakes the target')).toBeDefined()
  })

  it('shows a delivered peer message with its body, target and mode', () => {
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'team',
            id: 'team:message:team-1:team-message-1',
            activity: {
              kind: 'message.delivered',
              id: 'team:message:delivered:team-1:team-message-1',
              teamId: 'team-1',
              messageId: 'team-message-1',
              senderName: 'Planner',
              targetId: 'member-2',
              delivery: 'quiet',
              content: 'Take the next task',
            },
          },
        ]}
        streaming={false}
      />,
    )

    // The receipt acknowledges a message that was already shown; the row keeps
    // the body it carried, names the target, and reports the delivery mode as a
    // label instead of leaving the internal message id as the card's text.
    expect(screen.getByText('Delivered')).toBeDefined()
    expect(screen.getByText('Take the next task')).toBeDefined()
    expect(screen.getByText('To member-2')).toBeDefined()
    expect(screen.getByText('Delivered quietly')).toBeDefined()
    expect(screen.queryByText('team-message-1')).toBeNull()
  })

  it('renders a peer message body as prose and names its sender', () => {
    const body = 'Rebase the branch on main and report back.\nLeave the migration scripts alone.'
    render(
      <Timeline
        sessionId="session-1"
        nodes={[
          {
            kind: 'team',
            id: 'team:message:team-1:team-message-1',
            activity: {
              kind: 'message.queued',
              id: 'team:message:queued:team-1:team-message-1',
              teamId: 'team-1',
              messageId: 'team-message-1',
              senderName: 'planner',
              targetId: 'member-1',
              content: body,
            },
          },
        ]}
        streaming={false}
      />,
    )

    // The host admits a peer body far past one line, so the row renders it as
    // prose — the event title style ends every line in an ellipsis — and names
    // the sender, since the id and the target alone leave the reader guessing
    // who asked for what.
    const rendered = screen.getByText(/Rebase the branch on main/u)
    expect(rendered.className).toBe('dsh-timeline__event-body')
    expect(rendered.textContent).toBe(body)
    expect(screen.getByText('From planner')).toBeDefined()
    expect(screen.getByText('To member-1')).toBeDefined()
  })
})

function resizeEntry(target: Element, width: number, height: number): ResizeObserverEntry {
  return {
    target,
    contentRect: { width, height } as DOMRectReadOnly,
  } as ResizeObserverEntry
}
