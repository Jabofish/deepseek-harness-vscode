import { describe, expect, it } from 'vitest'
import { rowCopyMarkdown } from './transcript-copy.js'
import type {
  FocusedTurnNode,
  FocusedWorkNode,
  PresentedTimelineNode,
} from './focused-timeline-projection.js'

function assistantTurn(markdown: string): FocusedWorkNode {
  return { kind: 'assistant-turn', id: 'turn-1', tools: [], blocks: [], markdown, streaming: false }
}

function focusedTurn(
  answer: FocusedTurnNode['answer'],
  nodes: FocusedTurnNode['nodes'] = [],
): PresentedTimelineNode {
  return {
    kind: 'focused-turn',
    id: 'focused-turn:1',
    turn: 1,
    nodes,
    sourceIds: [],
    foldable: false,
    answer,
  }
}

describe('rowCopyMarkdown', () => {
  it('copies the answer text of every readable row kind', () => {
    expect(
      rowCopyMarkdown({
        kind: 'assistant-message',
        id: 'assistant-1',
        markdown: '## Answer\n\ntext',
        streaming: false,
      }),
    ).toBe('## Answer\n\ntext')
    expect(rowCopyMarkdown(assistantTurn('final **reply**'))).toBe('final **reply**')
    // Decision: a user row carries the same behaviour as an assistant row.
    expect(rowCopyMarkdown({ kind: 'user-message', id: 'user-1', markdown: 'my prompt' })).toBe('my prompt')
  })

  it('keeps reasoning, notices and turn markers out of the copy', () => {
    const rows: readonly PresentedTimelineNode[] = [
      { kind: 'reasoning', id: 'reasoning-1', markdown: 'thinking out loud', streaming: false },
      { kind: 'notice', id: 'notice-1', level: 'warning', text: 'beware' },
      { kind: 'turn-terminal', id: 'terminal-1', turn: 1, sequence: 4, reason: 'aborted' },
      { kind: 'command-input', id: 'command-1', text: '/goal' },
      { kind: 'event-group', id: 'events-1', events: [], textSize: 4 },
    ]
    for (const row of rows) expect(rowCopyMarkdown(row)).toBeUndefined()
  })

  it('prefers the settled final reply of a focused turn', () => {
    const answer = {
      kind: 'assistant-message' as const,
      id: 'assistant-2',
      markdown: 'the reply',
      streaming: false,
    }
    expect(rowCopyMarkdown(focusedTurn(answer, [assistantTurn('intermediate step')]))).toBe('the reply')
  })

  it('keeps a settled focused turn with no readable text a strict no-op', () => {
    // DSH settles an image-only reply with empty Markdown; copying the process
    // text that produced it would publish something the user never addressed.
    const emptyAnswer = {
      kind: 'assistant-message' as const,
      id: 'assistant-6',
      markdown: '',
      streaming: false,
    }
    expect(rowCopyMarkdown(focusedTurn(emptyAnswer, [assistantTurn('process text')]))).toBeUndefined()
  })
})
