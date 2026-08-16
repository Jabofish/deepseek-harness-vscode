import type { ReactElement } from 'react'
import type { BackendState } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export function RuntimeStatus({ state }: { readonly state: BackendState }): ReactElement {
  return unimplemented<ReactElement>('compact backend connection status', [
    'show idle, discovering, attaching, starting, connected, missing, failed, and reconnecting states',
    'identify external versus managed ownership without exposing pid by default',
    'provide retry and diagnostics affordances only when relevant',
    `state ${state.kind}`,
  ])
}
