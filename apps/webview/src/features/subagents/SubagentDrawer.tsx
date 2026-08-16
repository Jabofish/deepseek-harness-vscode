import type { ReactElement } from 'react'
import type { SubagentView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface SubagentDrawerProps {
  readonly subagents: readonly SubagentView[]
  readonly onSend: (sessionId: string, message: string) => void
}

export function SubagentDrawer(props: SubagentDrawerProps): ReactElement {
  return unimplemented<ReactElement>('subagent inspection and messaging drawer', [
    'display parent-child relationships, model, status, and latest activity',
    'route messages to the selected subagent session only',
    'keep subagent timelines lazy and isolated from the primary timeline render loop',
    `subagents ${props.subagents.length}; callback ${typeof props.onSend}`,
  ])
}
