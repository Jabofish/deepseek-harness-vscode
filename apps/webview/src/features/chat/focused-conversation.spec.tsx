// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { ConversationLayoutProvider } from '../../app/ConversationLayoutProvider.js'
import { ConversationLayoutControl } from '../../app/ConversationLayoutControl.js'
import { Timeline } from './Timeline.js'

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

function session(
  mode: TranscriptViewMode = 'standard',
  source = nodes,
  reveal?: string,
  requestId = 'reveal',
): ReactElement {
  return (
    <ConversationLayoutProvider initialLayout="focused">
      <ConversationLayoutControl />
      <Timeline
        sessionId="fixture"
        nodes={source}
        streaming={false}
        transcriptView={mode}
        {...(reveal === undefined ? {} : { revealTarget: { nodeId: reveal, requestId } })}
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
    expect(screen.getByRole('button', { name: /Failed tool calls: 1/u })).toBeDefined()
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
})
