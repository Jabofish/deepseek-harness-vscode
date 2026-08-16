import type { ReactElement } from 'react'
import { unimplemented } from '@dsh-vscode/domain'

export interface DiagnosticsSnapshot {
  readonly extensionVersion: string
  readonly dshVersion?: string
  readonly state: string
  readonly endpointKind?: 'configured' | 'external' | 'managed'
  readonly recentEvents: readonly string[]
}

export function DiagnosticsPanel({ snapshot }: { readonly snapshot: DiagnosticsSnapshot }): ReactElement {
  return unimplemented<ReactElement>('redacted diagnostics panel', [
    'show versions, state transitions, provider outcomes, and bounded error codes',
    'exclude endpoint address, pid, workspace path, prompts, tool bodies, and credentials by default',
    'copy only a visibly previewed redacted report after explicit action',
    `extension ${snapshot.extensionVersion}; state ${snapshot.state}; events ${snapshot.recentEvents.length}`,
  ])
}
