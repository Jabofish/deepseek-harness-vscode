// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const answer = (id: string, markdown: string): Extract<TimelineNode, { kind: 'assistant-message' }> => ({
  kind: 'assistant-message',
  id,
  turn: 1,
  markdown,
  streaming: false,
  turnCompleted: true,
})

it('acknowledges only after every omitted answer block has loaded and committed', async () => {
  vi.useFakeTimers()
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
  await act(() => vi.advanceTimersByTimeAsync(20))
  expect(loadFullNode).toHaveBeenCalledTimes(1)
  expect(responseRendered).not.toHaveBeenCalled()
  await act(async () => {
    finish(answer('first', 'Complete first block'))
    await Promise.resolve()
  })
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1, false)
})

it('does not acknowledge failed hydration or the previous content version', async () => {
  vi.useFakeTimers()
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
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(screen.getByText('Previous complete body')).toBeTruthy()
  view.rerender(
    <Timeline {...props} nodes={[answer('answer', 'Prefix')]} contentVersions={{ answer: 'new' }} />,
  )
  await act(() => vi.advanceTimersByTimeAsync(500))
  expect(loadFullNode).toHaveBeenCalledTimes(3)
  expect(responseRendered).not.toHaveBeenCalled()
  await act(async () => {
    finish(answer('answer', 'Current complete body'))
    await Promise.resolve()
  })
  await act(() => vi.advanceTimersByTimeAsync(0))
  expect(responseRendered).toHaveBeenCalledExactlyOnceWith('s', 1, false)
})
