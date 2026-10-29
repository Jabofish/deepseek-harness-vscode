import { terminalPresentationFailed } from '@dsh-vscode/domain'
import type { DisplayTimelineNode } from './timeline-shared.js'
import type { ToolTimelineNode } from './ToolCallCollection.js'
import type { TimelineNode } from '@dsh-vscode/timeline'
type ActivityNode = DisplayTimelineNode | TimelineNode

function trace(node: ActivityNode): boolean {
  if (node.kind === 'reasoning') return true
  if (node.kind === 'tool')
    return node.tool.submittedPlan === undefined && (node.tool.images?.length ?? 0) === 0
  if (node.kind !== 'assistant-message' && node.kind !== 'assistant-turn') return false
  return (
    node.markdown.trim() === '' &&
    (node.images?.length ?? 0) === 0 &&
    (node.kind !== 'assistant-turn' || node.tools.every((tool) => tool.tool.submittedPlan === undefined))
  )
}
function settledTool(node: ToolTimelineNode): boolean {
  return (
    node.tool.status === 'completed' &&
    node.tool.preparation === undefined &&
    node.tool.error === undefined &&
    node.tool.autoReviewDenial === undefined &&
    !terminalPresentationFailed(node.tool.presentation)
  )
}
function settled(node: ActivityNode): boolean {
  if (node.kind === 'tool') return settledTool(node)
  if (node.kind === 'reasoning') return !node.streaming
  return (
    (node.kind === 'assistant-message' || node.kind === 'assistant-turn') &&
    !node.streaming &&
    node.reasoning?.streaming !== true &&
    node.interrupted !== true &&
    (node.kind !== 'assistant-turn' || node.tools.every(settledTool))
  )
}

/** Presentation only: retain all active/error work plus the previous activity.
 * Text, images, plans and user/system boundaries are never compacted. */
export function compactActivity<Node extends ActivityNode>(
  nodes: readonly Node[],
): {
  readonly nodes: readonly Node[]
  readonly hidden: number
} {
  let result: Node[] | undefined
  let hidden = 0
  let index = 0
  while (index < nodes.length) {
    if (!trace(nodes[index]!)) {
      result?.push(nodes[index]!)
      index++
      continue
    }
    const start = index
    let completed = 0
    while (index < nodes.length && trace(nodes[index]!)) {
      if (settled(nodes[index]!)) completed++
      index++
    }
    const keep = completed < index - start ? 1 : 2
    let omit = Math.max(0, completed - keep)
    hidden += omit
    if (omit > 0) result ??= nodes.slice(0, start)
    if (result === undefined) continue
    // Allocate only the retained output, not index sets and full-run arrays
    // on every streaming delta. The original nodes remain immutable.
    for (let cursor = start; cursor < index; cursor++) {
      const node = nodes[cursor]!
      if (omit > 0 && settled(node)) omit--
      else result.push(node)
    }
  }
  return { nodes: result ?? nodes, hidden }
}
