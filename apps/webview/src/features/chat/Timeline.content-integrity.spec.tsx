// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { Timeline } from './Timeline.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const message = (id: string, markdown: string): TimelineNode => ({
  kind: 'assistant-message',
  id,
  markdown,
  streaming: false,
  turn: 1,
  turnCompleted: true,
})

it('opens an omitted earlier message and copies all combined message blocks in order', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const onOpenFullContent = vi.fn()
  const loadFullContent = vi.fn().mockResolvedValue('Complete first answer')
  render(
    <Timeline
      sessionId="s"
      streaming={false}
      omittedNodeIds={['first']}
      onOpenFullContent={onOpenFullContent}
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
  fireEvent.click(screen.getByRole('button', { name: 'Open full content' }))
  await waitFor(() => expect(onOpenFullContent).toHaveBeenCalledWith('first'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('Complete first answer\n\nFinal answer'))
  expect(loadFullContent).toHaveBeenCalledWith('first')
})

it.each([false, true])('keeps an omitted live message visible while reasoning-only=%s', (reasoningOnly) => {
  render(
    <Timeline
      sessionId="s"
      streaming
      running
      omittedNodeIds={['live']}
      onOpenFullContent={vi.fn()}
      nodes={[
        {
          kind: 'assistant-message',
          id: 'live',
          markdown: reasoningOnly ? '' : 'Current output',
          streaming: !reasoningOnly,
          turn: 1,
          ...(reasoningOnly ? { reasoning: { markdown: 'Current reasoning', streaming: true } } : {}),
        },
      ]}
    />,
  )
  expect(screen.getByRole('note').textContent).toContain('latest output')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open full content' }).disabled).toBe(true)
})
