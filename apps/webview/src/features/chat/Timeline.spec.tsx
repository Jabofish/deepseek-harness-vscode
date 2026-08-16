// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
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
  afterEach(() => cleanup())

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
      },
    ]

    const { container } = render(<Timeline sessionId="session-1" nodes={nodes} streaming={false} />)

    expect(screen.getByText('Thinking')).toBeDefined()
    expect(container.querySelector('details')?.open).toBe(false)
    expect(screen.getByRole('heading', { name: 'Done' })).toBeDefined()
    expect(screen.getByText('result')).toBeDefined()
  })
})
