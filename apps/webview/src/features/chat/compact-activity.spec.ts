import { expect, it } from 'vitest'
import { compactActivity } from './compact-activity.js'
import type { DisplayTimelineNode } from './timeline-shared.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'

const tool = (id: string): ToolTimelineNode => ({
  kind: 'tool',
  id,
  tool: { id, name: 'read', title: id, category: 'read', status: 'completed', metadata: {} },
})

it('keeps the previous activity and every active or failed tool without mutating the source', () => {
  const active = tool('active')
  const failed = tool('failed')
  const source = [
    tool('old'),
    tool('previous'),
    { ...active, tool: { ...active.tool, status: 'running' as const } },
    { ...failed, tool: { ...failed.tool, error: 'Visible failure' } },
  ]
  const result = compactActivity(source)
  expect(result.nodes.map((node) => node.id)).toEqual(['previous', 'active', 'failed'])
  expect(result.hidden).toBe(1)
  expect(source).toHaveLength(4)
  expect(result.nodes[0]).toBe(source[1])
})

it('keeps two settled activities per run and never crosses an answer or user boundary', () => {
  const answer: DisplayTimelineNode = {
    kind: 'assistant-message',
    id: 'answer',
    markdown: 'The actual response',
    streaming: false,
  }
  const source: DisplayTimelineNode[] = [
    tool('a'),
    tool('b'),
    tool('c'),
    answer,
    tool('d'),
    tool('e'),
    tool('f'),
  ]
  expect(compactActivity(source).nodes.map((node) => node.id)).toEqual(['b', 'c', 'answer', 'e', 'f'])
  expect(compactActivity([answer]).nodes).toEqual([answer])
})

it('preserves image replies and a completed tool whose structured result reports failure', () => {
  const failed = tool('failed')
  const source: DisplayTimelineNode[] = [
    tool('a'),
    tool('b'),
    {
      ...failed,
      tool: {
        ...failed.tool,
        presentation: { card: 'terminal', phase: 'result', exitCode: 1, output: 'Failure' },
      },
    },
    {
      kind: 'assistant-message',
      id: 'image',
      markdown: '',
      streaming: false,
      images: [{ attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }],
    },
  ]
  const result = compactActivity(source)
  expect(result.nodes.map((node) => node.id)).toEqual(['b', 'failed', 'image'])
})
