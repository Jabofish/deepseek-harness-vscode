// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'

import { Timeline } from './Timeline.js'

describe('Timeline', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('can load earlier history when the current window has no visible anchor', () => {
    const onLoadOlderHistory = vi.fn()
    render(
      <Timeline
        sessionId="s"
        streaming={false}
        nodes={[]}
        hasMoreHistory
        onLoadOlderHistory={onLoadOlderHistory}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }))
    expect(onLoadOlderHistory).toHaveBeenCalled()
  })

  it('does not carry expanded process details into another session with reused source IDs', () => {
    const nodes: readonly TimelineNode[] = [
      {
        kind: 'tool',
        id: 'tool:read',
        tool: {
          id: 'read',
          name: 'read',
          category: 'filesystem',
          title: 'Read',
          status: 'completed',
          inputSummary: 'README.md',
          outputSummary: 'file contents',
          metadata: {},
        },
      },
    ]
    const view = render(<Timeline sessionId="first" nodes={nodes} streaming={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Expand Read details' }))
    expect(screen.getByRole('button', { name: 'Collapse Read details' })).toBeDefined()

    view.rerender(<Timeline sessionId="second" nodes={nodes} streaming={false} />)
    expect(screen.getByRole('button', { name: 'Expand Read details' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Collapse Read details' })).toBeNull()
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

  it('keeps unreadable DSH frames out of the default transcript', () => {
    const nodes: readonly TimelineNode[] = [
      { kind: 'user-message', id: 'user-1', markdown: 'Please continue' },
      { kind: 'event', id: 'event-1', name: 'agent/inbox/spliced', payload: { count: 2 } },
      { kind: 'assistant-message', id: 'assistant-1', markdown: 'Continuing.', streaming: false },
    ]
    const { rerender } = render(
      <Timeline sessionId="session-1" nodes={nodes} streaming={false} showDshEvents={false} />,
    )

    expect(screen.getByText('Please continue')).toBeDefined()
    expect(screen.getByText('Continuing.')).toBeDefined()
    expect(screen.queryByText('agent/inbox/spliced')).toBeNull()

    rerender(<Timeline sessionId="session-1" nodes={nodes} streaming={false} showDshEvents />)

    expect(screen.getByText('agent/inbox/spliced')).toBeDefined()
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

    expect(screen.getByText('Before the tool.')).toBeDefined()
    expect(screen.getByText('After the tool.')).toBeDefined()
    const tool = screen.getByRole('button', { name: 'Expand Read details' })
    expect(tool).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Branch into a new conversation' }))
    expect(branch).toHaveBeenCalledWith(7)
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
})

describe('Timeline transcript copy fallback', () => {
  afterEach(cleanup)

  it('copies the addressed row as Markdown when the menu Copy has no selection', () => {
    const { container } = render(
      <Timeline
        sessionId="session-1"
        nodes={[
          { kind: 'user-message', id: 'user-1', markdown: 'run it' },
          {
            kind: 'assistant-message',
            id: 'assistant-1',
            markdown: '## Done\n\n- one',
            streaming: false,
            turn: 1,
          },
        ]}
        streaming={false}
      />,
    )

    const row = container.querySelector<HTMLElement>('[data-node-id="assistant-1"]')
    expect(row).not.toBeNull()
    fireEvent.contextMenu(row!)

    const written: string[] = []
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, text: string): void => void written.push(`${type}:${text}`) },
    })
    act(() => {
      document.dispatchEvent(event)
    })

    expect(written).toEqual(['text/plain:## Done\n\n- one'])
    expect(event.defaultPrevented).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('Copied')
  })
})
