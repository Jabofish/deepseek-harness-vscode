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
  const hidden = new Set<number>()
  let run: number[] = []
  const flush = (): void => {
    const completed = run.filter((index) => settled(nodes[index]!))
    const keep = run.length > completed.length ? 1 : 2
    for (const index of completed.slice(0, -keep)) hidden.add(index)
    run = []
  }
  nodes.forEach((node, index) => {
    if (trace(node)) run.push(index)
    else flush()
  })
  flush()
  return {
    nodes: hidden.size === 0 ? nodes : nodes.filter((_, index) => !hidden.has(index)),
    hidden: hidden.size,
  }
}
