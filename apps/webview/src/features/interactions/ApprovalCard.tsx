import type { ReactElement } from 'react'
import type { PermissionRequest } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ApprovalCardProps {
  readonly request: PermissionRequest
  readonly disabled: boolean
  readonly onRespond: (optionId: string) => void
}

export function ApprovalCard(props: ApprovalCardProps): ReactElement {
  return unimplemented<ReactElement>('permission approval interaction card', [
    'show exact action summary, risk, and DSH-provided choices without inventing broader permissions',
    'make deny visually equal and keyboard accessible',
    'disable after one response and recover cleanly from stale requests',
    'never execute a tool action in the Webview',
    `request ${props.request.id}; risk ${props.request.risk}; disabled ${String(props.disabled)}; callback ${typeof props.onRespond}`,
  ])
}
