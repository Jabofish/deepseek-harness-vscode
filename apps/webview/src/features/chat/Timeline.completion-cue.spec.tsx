// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

afterEach(cleanup)

const answer = (id: string, markdown: string): Extract<TimelineNode, { kind: 'assistant-message' }> => ({
  kind: 'assistant-message',
  id,
  turn: 1,
  markdown,
  streaming: false,
  turnCompleted: true,
})

it('acknowledges only after every omitted answer block has loaded and committed', async () => {
  let finish!: (node: TimelineNode) => void
  const loadFullNode = vi.fn(
    () =>
      new Promise<TimelineNode>((done) => {
        finish = done
      }),
  )
  const responseRendered = vi.fn(() => {
    expect(screen.getByText('Complete first block')).toBeTruthy()
    expect(screen.getByText('Final second block')).toBeTruthy()
    return Promise.resolve(false)
  })
  render(
    <Timeline
      sessionId="s"
      nodes={[answer('first', 'Clipped first block'), answer('second', 'Final second block')]}
      streaming={false}
      omittedNodeIds={['first']}
      loadFullNode={loadFullNode}
      onResponseRendered={responseRendered}
    />,
  )
  await waitFor(() => expect(loadFullNode).toHaveBeenCalledTimes(1))
  await act(async () => {
    await new Promise((done) => setTimeout(done, 20))
  })
  expect(responseRendered).not.toHaveBeenCalled()
  act(() => finish(answer('first', 'Complete first block')))
  await waitFor(() => expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1))
})

it('does not acknowledge failed hydration or the previous content version', async () => {
  let finish!: (node: TimelineNode) => void
  const loadFullNode = vi
    .fn()
    .mockResolvedValueOnce(answer('answer', 'Previous complete body'))
    .mockRejectedValueOnce(new Error('temporary read failure'))
    .mockImplementation(
      () =>
        new Promise<TimelineNode>((done) => {
          finish = done
        }),
    )
  const responseRendered = vi.fn(() => {
    expect(screen.getByText('Current complete body')).toBeTruthy()
    return Promise.resolve(false)
  })
  const props = {
    sessionId: 's',
    streaming: false,
    omittedNodeIds: ['answer'],
    loadFullNode,
    onResponseRendered: responseRendered,
  }
  const view = render(
    <Timeline
      {...props}
      nodes={[{ ...answer('answer', 'Prefix'), turnCompleted: false }]}
      contentVersions={{ answer: 'old' }}
    />,
  )
  await screen.findByText('Previous complete body')
  view.rerender(
    <Timeline {...props} nodes={[answer('answer', 'Prefix')]} contentVersions={{ answer: 'new' }} />,
  )
  await waitFor(() => expect(loadFullNode).toHaveBeenCalledTimes(3))
  expect(responseRendered).not.toHaveBeenCalled()
  act(() => finish(answer('answer', 'Current complete body')))
  await waitFor(() => expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1))
})
