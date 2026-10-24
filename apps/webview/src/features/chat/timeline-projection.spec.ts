import type { TimelineNode } from '@dsh-vscode/timeline'
import { expect, it } from 'vitest'
import { createDisplayNodeProjector } from './timeline-projection.js'

function steps(count: number): readonly TimelineNode[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index): readonly TimelineNode[] => [
      Object.freeze({
        kind: 'tool',
        id: `tool-${index}`,
        tool: Object.freeze({
          id: `tool-${index}`,
          name: 'read',
          title: 'Read',
          category: 'read',
          status: 'completed',
          turn: 1,
          metadata: Object.freeze({}),
        }),
      }),
      Object.freeze({
        kind: 'assistant-message',
        id: `message-${index}`,
        markdown: `Reply ${index}.`,
        streaming: false,
        turn: 1,
        step: index + 1,
        sequence: index * 2 + 2,
        turnCompleted: index === count - 1,
      }),
    ]).flat(),
  )
}

it.each(['compact', 'standard', 'detailed'] as const)(
  'bounds array traversal for alternating tools and replies in %s view',
  (view) => {
    const nodes = steps(64)
    let visitedElements = 0
    const originalIterator = Array.prototype[Symbol.iterator]
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      value: function* (this: unknown[]) {
        const first: unknown = this[0]
        const tracked =
          typeof first === 'object' && first !== null && 'kind' in first && first.kind === 'tool'
        for (let index = 0; index < this.length; index++) {
          if (tracked) visitedElements++
          yield this[index]
        }
      },
    })
    let result: ReturnType<ReturnType<typeof createDisplayNodeProjector>>
    try {
      result = createDisplayNodeProjector()(nodes, false, view)
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, { value: originalIterator })
    }
    // Includes both public input walks, as well as any tool/block array copies.
    expect(visitedElements).toBeLessThanOrEqual(64 * 8)
    expect(result.nodes).toHaveLength(1)
    const turn = result.nodes[0]
    expect(turn).toMatchObject({ id: 'assistant-turn:message-63', turn: 1, step: 64, sequence: 128 })
    if (turn?.kind !== 'assistant-turn') throw new Error('Expected an assistant turn')
    expect(turn.tools.map((node) => node.id)).toEqual(
      nodes.filter((node) => node.kind === 'tool').map((node) => node.id),
    )
    expect(turn.blocks.map((block) => block.kind)).toEqual(
      Array.from({ length: 64 }, () => ['tool', 'message']).flat(),
    )
    expect(turn.markdown).toBe(Array.from({ length: 64 }, (_, index) => `Reply ${index}.`).join('\n\n'))
  },
)

it('preserves cached prefix arrays, adjacent messages, trailing work IDs and verbose nodes', () => {
  const project = createDisplayNodeProjector()
  const boundary: TimelineNode = Object.freeze({ kind: 'user-message', id: 'user', markdown: 'Next' })
  const prefix = [...steps(2), boundary]
  const first = project(prefix, false, 'standard')
  const turn = first.nodes[0]
  if (turn?.kind !== 'assistant-turn') throw new Error('Expected an assistant turn')
  Object.freeze(turn.tools)
  Object.freeze(turn.blocks)
  const tail = steps(2)
  const extended = project([...prefix, ...tail], false, 'standard')
  expect(extended.nodes[0]).toBe(turn)
  expect(turn.tools).toHaveLength(2)
  expect(turn.blocks).toHaveLength(4)

  const trailingTool = tail[0]!
  const withTool = createDisplayNodeProjector()([...tail, trailingTool], false, 'standard').nodes
  expect(withTool[0]?.id).toBe('assistant-turn:assistant-turn:message-1')
  const nextMessage: TimelineNode = {
    kind: 'assistant-message',
    id: 'next',
    markdown: 'Separate',
    streaming: false,
    turn: 1,
  }
  const adjacent = createDisplayNodeProjector()([...tail, nextMessage], false, 'standard').nodes
  expect(adjacent.map((node) => node.id)).toEqual(['assistant-turn:message-1', 'next'])
  expect(createDisplayNodeProjector()(tail, false, 'verbose').nodes).toEqual(tail)
})
