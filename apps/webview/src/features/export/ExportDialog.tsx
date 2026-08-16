import type { ReactElement } from 'react'
import type { SessionExportOptions } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface ExportDialogProps {
  readonly sessionId: string
  readonly onExport: (options: SessionExportOptions) => void
}

export function ExportDialog(props: ExportDialogProps): ReactElement {
  return unimplemented<ReactElement>('session export dialog', [
    'offer markdown, JSON, and ZIP with attachment and reasoning inclusion options',
    'delegate destination selection and all filesystem writes to Extension Host',
    'warn about sensitive content and preserve cancellation',
    `session ${props.sessionId}; callback ${typeof props.onExport}`,
  ])
}
