import type { TimelineNode } from './nodes.js'

export type ToolTimelineNode = Extract<TimelineNode, { readonly kind: 'tool' }>

/** Keep recursive tool rendering bounded even when history is malformed. */
export const MAX_TOOL_CALL_TREE_DEPTH = 256

export interface ToolCallTreeNode {
  readonly node: ToolTimelineNode
  readonly children: readonly ToolCallTreeNode[]
}

/**
 * Project the flat timeline tool rows into the recursive parent/subcall shape
 * used by DSH's ToolCallTree. Missing parents are deliberately kept as roots
 * so a paged history window can never hide a real child call.
 */
export function projectToolCallTree(tools: readonly ToolTimelineNode[]): readonly ToolCallTreeNode[] {
  const nodesById = new Map<string, ToolTimelineNode>()
  const order: string[] = []
  for (const node of tools) {
    if (nodesById.has(node.id)) continue
    nodesById.set(node.id, node)
    order.push(node.id)
  }

  const parentByChild = new Map<string, string>()
  for (const id of order) {
    const node = nodesById.get(id)
    const parentId = node?.tool.parentCallId
    if (node === undefined || parentId === undefined || !nodesById.has(parentId)) continue
    if (parentId === id || createsCycle(parentByChild, id, parentId)) continue
    parentByChild.set(id, parentId)
  }

  trimOverDepthEdges(parentByChild)

  const childrenByParent = new Map<string, string[]>()
  for (const id of order) {
    const parentId = parentByChild.get(id)
    if (parentId === undefined) continue
    const children = childrenByParent.get(parentId) ?? []
    children.push(id)
    childrenByParent.set(parentId, children)
  }

  const roots = order.filter((id) => !parentByChild.has(id))
  return roots.map((id) => projectNode(id, nodesById, childrenByParent))
}

function projectNode(
  id: string,
  nodesById: ReadonlyMap<string, ToolTimelineNode>,
  childrenByParent: ReadonlyMap<string, readonly string[]>,
  visited = new Set<string>(),
  depth = 1,
): ToolCallTreeNode {
  const node = nodesById.get(id)
  if (node === undefined) throw new Error(`Missing tool call ${id}`)
  if (visited.has(id) || depth > MAX_TOOL_CALL_TREE_DEPTH) return { node, children: [] }

  const nextVisited = new Set(visited)
  nextVisited.add(id)
  const childIds = depth === MAX_TOOL_CALL_TREE_DEPTH ? [] : (childrenByParent.get(id) ?? [])
  return {
    node,
    children: childIds.map((childId) =>
      projectNode(childId, nodesById, childrenByParent, nextVisited, depth + 1),
    ),
  }
}

function createsCycle(
  parentByChild: ReadonlyMap<string, string>,
  childId: string,
  parentId: string,
): boolean {
  const visited = new Set<string>()
  let cursor: string | undefined = parentId
  while (cursor !== undefined) {
    if (cursor === childId || visited.has(cursor)) return true
    visited.add(cursor)
    cursor = parentByChild.get(cursor)
  }
  return false
}

function trimOverDepthEdges(parentByChild: Map<string, string>): void {
  for (const childId of [...parentByChild.keys()]) {
    if (depthOf(parentByChild, childId) <= MAX_TOOL_CALL_TREE_DEPTH) continue
    parentByChild.delete(childId)
  }
}

function depthOf(parentByChild: ReadonlyMap<string, string>, childId: string): number {
  let depth = 1
  let cursor: string | undefined = childId
  const visited = new Set<string>()
  while (cursor !== undefined) {
    if (visited.has(cursor)) return MAX_TOOL_CALL_TREE_DEPTH + 1
    visited.add(cursor)
    const parent = parentByChild.get(cursor)
    if (parent === undefined) return depth
    depth += 1
    if (depth > MAX_TOOL_CALL_TREE_DEPTH) return depth
    cursor = parent
  }
  return depth
}
