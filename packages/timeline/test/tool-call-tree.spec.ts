import { describe, expect, it } from 'vitest'

import {
  MAX_TOOL_CALL_TREE_DEPTH,
  projectToolCallTree,
  type ToolTimelineNode,
} from '../src/tool-call-tree.js'

function toolNode(
  id: string,
  parentCallId?: string,
  status: 'running' | 'completed' | 'failed' = 'completed',
): ToolTimelineNode {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      ...(parentCallId === undefined ? {} : { parentCallId }),
      name: id,
      category: 'test',
      title: id,
      status,
      metadata: {},
    },
  }
}

describe('projectToolCallTree', () => {
  it('projects nested dispatches while preserving lifecycle states and order', () => {
    const roots = projectToolCallTree([
      toolNode('root', undefined, 'running'),
      toolNode('child-a', 'root', 'completed'),
      toolNode('grandchild', 'child-a', 'failed'),
      toolNode('child-b', 'root', 'running'),
    ])

    expect(roots.map((entry) => entry.node.id)).toEqual(['root'])
    expect(roots[0]?.node.tool.status).toBe('running')
    expect(roots[0]?.children.map((entry) => entry.node.id)).toEqual(['child-a', 'child-b'])
    expect(roots[0]?.children[0]?.children[0]?.node.tool.status).toBe('failed')
  })

  it('keeps a child whose parent is outside the history window visible as a root', () => {
    const roots = projectToolCallTree([toolNode('child', 'missing-parent', 'running')])

    expect(roots).toHaveLength(1)
    expect(roots[0]?.node.id).toBe('child')
    expect(roots[0]?.children).toEqual([])
  })

  it('rejects self and cyclic edges without dropping the affected calls', () => {
    const roots = projectToolCallTree([toolNode('self', 'self'), toolNode('a', 'b'), toolNode('b', 'a')])

    expect(roots.map((entry) => entry.node.id)).toEqual(['self', 'b'])
    expect(roots[1]?.children.map((entry) => entry.node.id)).toEqual(['a'])
  })

  it('breaks edges beyond the recursion ceiling while retaining every node', () => {
    const tools: ToolTimelineNode[] = [toolNode('call-1')]
    for (let index = 2; index <= MAX_TOOL_CALL_TREE_DEPTH + 1; index += 1)
      tools.push(toolNode(`call-${index}`, `call-${index - 1}`))

    const roots = projectToolCallTree(tools)
    const attached = new Set<string>()
    const visit = (node: (typeof roots)[number]): void => {
      attached.add(node.node.id)
      for (const child of node.children) visit(child)
    }
    for (const root of roots) visit(root)

    expect(attached.size).toBe(tools.length)
    expect(roots.map((entry) => entry.node.id)).toEqual(['call-1', `call-${MAX_TOOL_CALL_TREE_DEPTH + 1}`])
  })
})
