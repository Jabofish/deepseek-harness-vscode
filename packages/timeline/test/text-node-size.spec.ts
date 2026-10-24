import { describe, expect, it } from 'vitest'
import { appendedTextNodeChars, type TimelineNode } from '../src/index.js'

describe('appended text node JSON size', () => {
  it('matches complete serialization across metadata changes, escaping, and reasoning removal', () => {
    let node: Extract<TimelineNode, { kind: 'assistant-message' }> = {
      kind: 'assistant-message',
      id: 'm',
      markdown: '\ud83d',
      streaming: true,
    }
    let chars = JSON.stringify(node).length
    const chunks = ['\ude00', '\n\t"\\', '中文', '\ud83d', '\ude80', '', 'end']
    for (let index = 0; index < 35; index++) {
      const reasoning =
        index % 5 === 4
          ? undefined
          : { markdown: chunks[(index + 1) % chunks.length]!, streaming: index % 2 === 0 }
      const { reasoning: _reasoning, ...old } = node
      void _reasoning
      const suffix = {
        ...old,
        markdown: chunks[index % chunks.length]!,
        streaming: index % 2 === 0,
        sequence: 10 ** (index % 6),
        turnCompleted: index % 3 === 0,
        modelLabel: `model-${index}`,
        ...(reasoning === undefined ? {} : { reasoning }),
        timing: { stepStartTime: 1, firstTokenTime: index, completedTime: index % 2 === 0 ? null : index },
      }
      const next = {
        ...suffix,
        markdown: node.markdown + suffix.markdown,
        ...(reasoning === undefined
          ? {}
          : { reasoning: { ...reasoning, markdown: (node.reasoning?.markdown ?? '') + reasoning.markdown } }),
      }
      // Undefined properties disappear at the actual JSON transport boundary.
      chars = appendedTextNodeChars(node, suffix, chars)
      expect(chars, `append ${index}`).toBe(JSON.stringify(next).length)
      node = next
    }
  })

  it('measures standalone reasoning with transient identity and completion changes', () => {
    const previous = {
      kind: 'reasoning',
      id: 'r',
      markdown: 'a\ud83d',
      streaming: true,
      liveAttemptId: 'a',
      liveLastIndex: 9,
    } as const
    const suffix = { ...previous, markdown: '\ude00\n', streaming: false, liveLastIndex: 10 }
    expect(appendedTextNodeChars(previous, suffix, JSON.stringify(previous).length)).toBe(
      JSON.stringify({ ...suffix, markdown: previous.markdown + suffix.markdown }).length,
    )
  })
})
