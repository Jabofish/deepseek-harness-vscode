import type { ReactElement } from 'react'
import type { WorkflowSummary } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface WorkflowDrawerProps {
  readonly workflows: readonly WorkflowSummary[]
  readonly onStart: (workflowId: string) => void
  readonly onCancel: (workflowId: string) => void
}

export function WorkflowDrawer(props: WorkflowDrawerProps): ReactElement {
  return unimplemented<ReactElement>('Workflow and Ralph lifecycle drawer', [
    'display stage hierarchy and live state from DSH events',
    'support explicit start and cancellation with confirmation where destructive',
    'represent completion, failure, cancellation, and unknown future stage states',
    `workflows ${props.workflows.length}; callbacks ${typeof props.onStart}/${typeof props.onCancel}`,
  ])
}
