import type { ReactElement } from 'react'
import type { PermissionRequest } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'

export interface ApprovalCardProps {
  readonly request: PermissionRequest
  readonly disabled: boolean
  readonly onRespond: (optionId: string) => void
}

export function ApprovalCard(props: ApprovalCardProps): ReactElement {
  return (
    <section
      className="dsh-interaction dsh-approval"
      role="group"
      aria-labelledby={`approval-${props.request.id}`}
    >
      <header className="dsh-interaction__header">
        <span className="dsh-interaction__icon" aria-hidden="true">
          <Icon name="alert" />
        </span>
        <div>
          <span className="dsh-app__eyebrow">ACTION REQUIRED</span>
          <h2 id={`approval-${props.request.id}`}>{props.request.title}</h2>
        </div>
      </header>
      <p className="dsh-interaction__description">{props.request.description}</p>
      <p className="dsh-interaction__risk">
        Risk{' '}
        <span className={`dsh-status-pill dsh-status-pill--${props.request.risk}`}>{props.request.risk}</span>
      </p>
      <div className="dsh-interaction__actions">
        {props.request.options.map((option) => (
          <button
            className="dsh-button dsh-button--secondary"
            key={option.id}
            type="button"
            disabled={props.disabled}
            onClick={() => props.onRespond(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  )
}
