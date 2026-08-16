import type { ReactElement } from 'react'
import type { ToolCallView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ToolCardProps {
  readonly tool: ToolCallView
  readonly expanded: boolean
  readonly onToggle: () => void
}

export function ToolCard(props: ToolCardProps): ReactElement {
  return unimplemented<ReactElement>('generic accessible tool call card', [
    'show title, category, status, timing, and bounded summaries',
    'collapse large inputs and outputs by default',
    'use semantic button state and keyboard toggle behavior',
    'never render raw secrets or untrusted HTML',
    `tool ${props.tool.name}; status ${props.tool.status}; expanded ${String(props.expanded)}; toggle callback ${typeof props.onToggle}`,
  ])
}
