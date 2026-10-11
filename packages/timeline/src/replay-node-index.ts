import type { TimelineNode } from './nodes.js'
import { sameUserMessagePreview, type TimelineNodeLookup } from './node-lookup.js'

/** Owned by one private replay array; no index escapes into published state. */
export function createReplayNodeIndex(nodes: readonly TimelineNode[]): TimelineNodeLookup {
  const ids: string[] = []
  const byId = new Map<string, number[]>()
  const optimistic = new Set<number>()
  const synchronize = (from: number): void => {
    const start = Math.max(0, Math.min(from, ids.length, nodes.length))
    for (let index = ids.length - 1; index >= start; index -= 1) {
      const id = ids[index]
      if (id === undefined) continue
      const positions = byId.get(id)
      positions?.pop()
      if (positions?.length === 0) byId.delete(id)
      optimistic.delete(index)
    }
    ids.length = start
    for (let index = start; index < nodes.length; index += 1) {
      const node = nodes[index]
      if (node === undefined) continue
      const id = node.id
      ids[index] = id
      const positions = byId.get(id)
      if (positions === undefined) byId.set(id, [index])
      else positions.push(index)
      if (node.kind === 'user-message' && id.startsWith('optimistic:user:')) optimistic.add(index)
    }
  }
  synchronize(0)
  return {
    synchronize,
    byId: (id, predicate): number => {
      const positions = byId.get(id) ?? []
      for (let cursor = positions.length - 1; cursor >= 0; cursor -= 1) {
        const index = positions[cursor]
        const node = index === undefined ? undefined : nodes[index]
        if (node !== undefined && (predicate === undefined || predicate(node))) return index ?? -1
      }
      return -1
    },
    optimisticUser: (event): number => {
      for (const index of optimistic) {
        const node = nodes[index]
        if (
          node?.kind === 'user-message' &&
          ((event.rpcId !== undefined && node.rpcId === event.rpcId) || sameUserMessagePreview(node, event))
        )
          return index
      }
      return -1
    },
  }
}
