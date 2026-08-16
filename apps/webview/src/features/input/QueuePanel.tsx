import type { ReactElement } from 'react'
import type { QueuedInput, RunningInputMode } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface QueuePanelProps {
  readonly items: readonly QueuedInput[]
  readonly onEdit: (id: string, text: string) => void
  readonly onRemove: (id: string) => void
  readonly onModeChange: (id: string, mode: RunningInputMode) => void
}

export function QueuePanel(props: QueuePanelProps): ReactElement {
  return unimplemented<ReactElement>('running-turn queue and steer panel', [
    'show queued inputs in server order with edit and remove actions',
    'allow queue-to-steer conversion only when the connected DSH supports it',
    'distinguish queue, steer, immediate send, and turn cancellation clearly',
    'reconcile optimistic edits against normalized queue events',
    `items ${props.items.length}; callbacks ${typeof props.onEdit}/${typeof props.onRemove}/${typeof props.onModeChange}`,
  ])
}
