// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('uses full content for the Webview context-menu copy of an omitted row', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const loadFullContent = vi.fn().mockResolvedValue('Complete answer')
  render(
    <Timeline
      sessionId="s"
      streaming={false}
      omittedNodeIds={['answer']}
      loadFullContent={loadFullContent}
      nodes={[message('answer', 'Visible prefix')]}
    />,
  )
  fireEvent.contextMenu(screen.getByText('Visible prefix'))
  const event = new Event('copy', { bubbles: true, cancelable: true })
  const setData = vi.fn()
  Object.defineProperty(event, 'clipboardData', { value: { setData } })
  fireEvent(document, event)
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Complete answer'))
  expect(setData).not.toHaveBeenCalledWith('text/plain', 'Visible prefix')
})

const message = (id: string, markdown: string): Extract<TimelineNode, { kind: 'assistant-message' }> => ({
  kind: 'assistant-message',
  id,
  markdown,
  streaming: false,
  turn: 1,
  turnCompleted: true,
})

function contextCopy(text: string): { event: Event; setData: ReturnType<typeof vi.fn> } {
  fireEvent.contextMenu(screen.getByText(text))
  const event = new Event('copy', { bubbles: true, cancelable: true })
  const setData = vi.fn()
  Object.defineProperty(event, 'clipboardData', { value: { setData } })
  fireEvent(document, event)
  return { event, setData }
}

it('copies the complete current body of a still-streaming transport-limited reply', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(
    <Timeline
      sessionId="s"
      streaming
      omittedNodeIds={['answer']}
      loadFullContent={vi.fn().mockResolvedValue('Complete current output')}
      nodes={[{ ...message('answer', 'Latest fragment'), streaming: true }]}
    />,
  )
  contextCopy('Latest fragment')
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Complete current output'))
})

it('leaves the clipboard untouched and announces a failed full-content copy', async () => {
  const writeText = vi.fn()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  render(
    <Timeline
      sessionId="s"
      streaming={false}
      omittedNodeIds={['answer']}
      loadFullContent={vi.fn().mockRejectedValue(new Error('Unavailable'))}
      nodes={[message('answer', 'Visible prefix')]}
    />,
  )
  const { event, setData } = contextCopy('Visible prefix')
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copy failed/i))
  expect(event.defaultPrevented).toBe(true)
  expect(setData).not.toHaveBeenCalled()
  expect(writeText).not.toHaveBeenCalled()
})

it('automatically displays every omitted message in a combined turn and copies all blocks', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const loadFullContent = vi.fn().mockResolvedValue('Complete first answer')
  const loadFullNode = vi.fn().mockResolvedValue(message('first', 'Complete first answer'))
  render(
    <Timeline
      sessionId="s"
      streaming={false}
      omittedNodeIds={['first']}
      loadFullNode={loadFullNode}
      loadFullContent={loadFullContent}
      nodes={[
        message('first', 'First prefix'),
        {
          kind: 'tool',
          id: 'tool',
          tool: {
            id: 'tool',
            name: 'read',
            category: 'read',
            title: 'Read',
            status: 'completed',
            turn: 1,
            metadata: {},
          },
        },
        message('last', 'Final answer'),
      ]}
    />,
  )
  await screen.findByText('Complete first answer')
  expect(screen.queryByText('First prefix')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open full content' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Complete first answer\n\nFinal answer'))
})

it.each([false, true])(
  'automatically displays the complete live body, reasoning-only=%s',
  async (reasoningOnly) => {
    const full: TimelineNode = {
      kind: 'assistant-message',
      id: 'live',
      markdown: reasoningOnly ? '' : 'Entire live output',
      streaming: !reasoningOnly,
      turn: 1,
      ...(reasoningOnly ? { reasoning: { markdown: 'Entire live reasoning', streaming: true } } : {}),
    }
    render(
      <Timeline
        sessionId="s"
        streaming
        running
        omittedNodeIds={['live']}
        loadFullNode={vi.fn().mockResolvedValue(full)}
        nodes={[
          {
            ...full,
            markdown: reasoningOnly ? '' : 'Current output',
            ...(reasoningOnly ? { reasoning: { markdown: 'Current reasoning', streaming: true } } : {}),
          },
        ]}
      />,
    )
    if (reasoningOnly) fireEvent.click(screen.getByRole('button', { name: 'Show reasoning' }))
    await screen.findByText(reasoningOnly ? 'Entire live reasoning' : 'Entire live output')
    expect(screen.queryByRole('button', { name: 'Open full content' })).toBeNull()
  },
)

it('retries a failed automatic read and refreshes an advancing live body', async () => {
  const first = { ...message('live', 'Prefix'), streaming: true }
  const loadFullNode = vi
    .fn()
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValueOnce({ ...first, markdown: 'Complete live output' })
    .mockResolvedValue({ ...first, markdown: 'Complete live output with later tokens', streaming: false })
  const view = render(
    <Timeline
      sessionId="s"
      streaming
      omittedNodeIds={['live']}
      nodes={[first]}
      loadFullNode={loadFullNode}
    />,
  )
  await screen.findByText('Complete live output')
  view.rerender(
    <Timeline
      sessionId="s"
      streaming={false}
      omittedNodeIds={['live']}
      nodes={[{ ...first, streaming: false }]}
      loadFullNode={loadFullNode}
    />,
  )
  await screen.findByText('Complete live output with later tokens')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('discards a late full node when its session has changed', async () => {
  let resolve!: (node: TimelineNode) => void
  const loadFullNode = vi.fn(
    () =>
      new Promise<TimelineNode>((done) => {
        resolve = done
      }),
  )
  const view = render(
    <Timeline
      sessionId="old"
      streaming={false}
      omittedNodeIds={['same']}
      nodes={[message('same', 'Old preview')]}
      loadFullNode={loadFullNode}
    />,
  )
  await waitFor(() => expect(loadFullNode).toHaveBeenCalledWith('same', expect.any(AbortSignal)))
  view.rerender(
    <Timeline
      sessionId="new"
      streaming={false}
      nodes={[message('same', 'New session answer')]}
      loadFullNode={loadFullNode}
    />,
  )
  await act(async () => {
    resolve(message('same', 'Wrong old answer'))
    await Promise.resolve()
  })
  expect(screen.queryByText('Wrong old answer')).toBeNull()
  expect(screen.getByText('New session answer')).toBeDefined()
})
