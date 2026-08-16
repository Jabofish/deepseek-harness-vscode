import type { ReactElement } from 'react'
import type { GoalView } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export function GoalTodoStrip({ goals }: { readonly goals: readonly GoalView[] }): ReactElement {
  return unimplemented<ReactElement>('goal and todo status strip', [
    'show active goal and compact completion counts above the composer',
    'expand to ordered status details without obscuring the conversation',
    'update from normalized events and reconcile with snapshots after reconnect',
    `goals ${goals.length}`,
  ])
}
