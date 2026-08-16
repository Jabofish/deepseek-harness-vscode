import type { ReactElement } from 'react'
import { unimplemented } from '@dsh-vscode/domain'

export interface RuntimeMissingViewProps {
  readonly searchedLocations: readonly string[]
  readonly busyAction: 'install' | 'select' | undefined
  readonly onAction: (action: 'install' | 'select' | 'copy-command' | 'open-docs') => void
}

export function RuntimeMissingView(props: RuntimeMissingViewProps): ReactElement {
  return unimplemented<ReactElement>('missing DSH runtime view', [
    'occupy the DSH view with a compact explanation and a bottom-pinned action area',
    'offer Install, Copy command, Select executable, Retry, and Documentation actions',
    'show the Node >=22.19 prerequisite and searched-location disclosure',
    'disable only the active action and keep error recovery keyboard accessible',
    'never start installation without an explicit click',
    `searched ${props.searchedLocations.length}; busy ${props.busyAction ?? 'none'}; action callback ${typeof props.onAction}`,
  ])
}
