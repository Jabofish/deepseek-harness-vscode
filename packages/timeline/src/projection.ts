import type { TimelineNode } from './nodes.js'

export interface VisibleTimelineWindow {
  readonly start: number
  readonly end: number
  readonly nodes: readonly TimelineNode[]
}

export function projectVisibleWindow(
  nodes: readonly TimelineNode[],
  start: number,
  end: number,
): VisibleTimelineWindow {
  const normalizedStart = Number.isFinite(start) ? Math.floor(start) : 0
  const normalizedEnd = Number.isFinite(end) ? Math.ceil(end) : nodes.length
  const safeStart = Math.max(0, Math.min(nodes.length, normalizedStart))
  const safeEnd = Math.max(safeStart, Math.min(nodes.length, normalizedEnd))
  return { start: safeStart, end: safeEnd, nodes: nodes.slice(safeStart, safeEnd) }
}
