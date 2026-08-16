import type { ReactElement } from 'react'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface SessionDrawerProps {
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
}

export function SessionDrawer(props: SessionDrawerProps): ReactElement {
  return unimplemented<ReactElement>('workspace and session drawer', [
    'support workspace filtering, search, create, rename, delete confirmation, and recent ordering',
    'show running and awaiting-input state without polling each row',
    'virtualize large session lists and preserve keyboard navigation',
    'route mutations through protocol requests and optimistic state only when reversible',
    `sessions ${props.sessions.length}; workspaces ${props.workspaces.length}; active ${props.activeSessionId ?? 'none'}`,
  ])
}
