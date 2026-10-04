import { assistantMessageId, type DisplayTimelineNode } from './timeline-shared.js'

/** Resolve grouped display rows using source identities, never by message text. */
export function timelineSourceNodeIds(node: DisplayTimelineNode): readonly string[] {
  if (node.kind === 'event-group') return node.events.map((event) => event.id)
  if (node.kind !== 'assistant-turn') return [node.id]
  const messageId = assistantMessageId(node)
  return [
    ...(messageId === undefined ? [] : [messageId]),
    ...node.tools.map((tool) => tool.id),
    ...node.blocks.map((block) =>
      block.kind === 'tool' ? block.node.id : block.id.replace(/^reasoning:/u, ''),
    ),
  ]
}
