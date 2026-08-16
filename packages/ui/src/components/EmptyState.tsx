import type { ReactElement, ReactNode } from 'react'
import { unimplemented } from '@dsh-vscode/domain'

export interface EmptyStateProps {
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  return unimplemented<ReactElement>('reusable empty state', [
    'use concise typography and no decorative illustration dependency',
    'support keyboard-reachable action content',
    'remain readable between 240px and 800px view widths',
    `title ${props.title}; description length ${props.description.length}; actions present ${String(props.actions !== undefined)}`,
  ])
}
