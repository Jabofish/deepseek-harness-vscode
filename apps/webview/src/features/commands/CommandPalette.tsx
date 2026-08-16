import type { ReactElement } from 'react'
import type { DynamicCommand } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface CommandPaletteProps {
  readonly commands: readonly DynamicCommand[]
  readonly query: string
  readonly onExecute: (command: string) => void
}

export function CommandPalette(props: CommandPaletteProps): ReactElement {
  return unimplemented<ReactElement>('composer slash-command completion', [
    'open after slash at the start of the composer and filter dynamic commands',
    'show description, source, and argument hint with keyboard navigation',
    'execute known commands through CommandRepository instead of model prompt submission',
    'show an explicit unknown-command error and preserve the draft',
    `commands ${props.commands.length}; query ${props.query}; callback ${typeof props.onExecute}`,
  ])
}
