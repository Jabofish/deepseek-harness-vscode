import { unimplemented } from '@dsh-vscode/domain'

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
  return unimplemented<VisibleTimelineWindow>('timeline visible-window projection', [
    'clamp indices to the node array',
    'preserve stable node identities for React virtualization',
    'avoid copying data outside the requested window',
    `node count ${nodes.length}; requested range ${start}-${end}`,
  ])
}
