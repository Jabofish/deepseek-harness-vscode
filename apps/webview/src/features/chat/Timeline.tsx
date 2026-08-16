import type { ReactElement } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { unimplemented } from '@dsh-vscode/domain'

export interface TimelineProps {
  readonly nodes: readonly TimelineNode[]
  readonly streaming: boolean
}

export function Timeline(props: TimelineProps): ReactElement {
  return unimplemented<ReactElement>('virtualized DSH conversation timeline', [
    'render messages, reasoning, tools, interactions, goals, jobs, and subagents through independent components',
    'use TanStack Virtual for large histories and keep stable measured row keys',
    'follow streaming output only while the user is already near the bottom',
    'batch deltas and avoid parsing markdown on each token',
    'offer copy and accessible expansion without rendering untrusted HTML',
    `nodes ${props.nodes.length}; streaming ${String(props.streaming)}`,
  ])
}
