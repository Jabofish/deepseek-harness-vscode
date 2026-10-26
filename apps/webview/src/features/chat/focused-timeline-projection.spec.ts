import { describe, expect, it } from 'vitest'
import type { DisplayTimelineNode } from './timeline-shared.js'
import { createFocusedTimelineProjector } from './focused-timeline-projection.js'

const message = (
  id: string,
  turn: number,
  completed = true,
): Extract<DisplayTimelineNode, { readonly kind: 'assistant-message' }> => ({
  kind: 'assistant-message',
  id,
  markdown: id,
  streaming: !completed,
  turn,
  turnCompleted: completed,
})

describe('focused Turn presentation', () => {
  it('keeps live, interrupted, failed and tool-ending process open', () => {
    for (const source of [
      [message('live', 1, false)],
      [{ ...message('interrupted', 1), interrupted: true } as DisplayTimelineNode],
      [
        message('failed', 1),
        {
          kind: 'turn-terminal',
          id: 'failure',
          turn: 1,
          sequence: 4,
          reason: 'error',
        } as DisplayTimelineNode,
      ],
    ]) {
      const [group] = createFocusedTimelineProjector()(source)
      expect(group?.kind === 'focused-turn' && group.foldable).toBe(false)
    }
    const [group] = createFocusedTimelineProjector()([
      message('commentary', 1),
      {
        kind: 'tool',
        id: 'call',
        tool: {
          id: 'call',
          name: 'dynamic',
          title: 'Dynamic tool',
          category: 'other',
          turn: 1,
          status: 'completed',
          metadata: {},
        },
      },
    ])
    expect(group?.kind === 'focused-turn' && group.answer).toBeUndefined()
  })

  it('does not fold unknown coordinates or cross human input, notices and turn boundaries', () => {
    const unknown: DisplayTimelineNode = {
      kind: 'assistant-message',
      id: 'legacy',
      markdown: 'legacy',
      streaming: false,
    }
    const input: DisplayTimelineNode = { kind: 'user-message', id: 'steer', markdown: 'change direction' }
    const notice: DisplayTimelineNode = { kind: 'notice', id: 'warn', level: 'warning', text: 'Warning' }
    const rows = createFocusedTimelineProjector()([
      unknown,
      message('before', 1),
      input,
      message('after', 1),
      notice,
      message('new', 2),
    ])
    expect(rows.map((row) => row.kind)).toEqual([
      'assistant-message',
      'focused-turn',
      'user-message',
      'focused-turn',
      'notice',
      'focused-turn',
    ])
    expect(rows[0]).toEqual(unknown)
    expect(rows[2]).toEqual(input)
    expect(rows[4]).toEqual(notice)
  })

  it('keeps every source message available in a long focused turn', () => {
    const source = Array.from({ length: 1_000 }, (_, index) => message(`message-${index}`, 1))
    const rows = createFocusedTimelineProjector()(source)
    const ids = rows.flatMap((row) => (row.kind === 'focused-turn' ? row.sourceIds : [row.id]))
    expect(ids).toEqual(source.map((node) => node.id))
  })
})
