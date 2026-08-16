import type { ReactElement, ReactNode } from 'react'

export interface EmptyStateProps {
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
}

export function EmptyState(props: EmptyStateProps): ReactElement {
  return (
    <section className="dsh-empty-state" aria-live="polite">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.actions === undefined ? null : <div className="dsh-empty-state__actions">{props.actions}</div>}
    </section>
  )
}
