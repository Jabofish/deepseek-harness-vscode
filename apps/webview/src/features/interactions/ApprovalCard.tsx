import { memo, type ReactElement } from 'react'
import type { PermissionRequest } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import { ContentFlow } from '../../components/common/ContentFlow.js'

export interface ApprovalCardProps {
  readonly request: PermissionRequest
  readonly disabled: boolean
  /** Command the request asks to authorize, resolved from the paired call. */
  readonly command?: string
  readonly onRespond: (optionId: string) => void
}

// A pending card docks in the composer slot for as long as the conversation
// streams behind it; memo keeps those frames from re-rendering the card.
export const ApprovalCard = memo(function ApprovalCard(props: ApprovalCardProps): ReactElement {
  const { locale, t } = useI18n()
  const description =
    props.request.displayReason?.[locale] ?? props.request.displayReason?.en ?? props.request.description
  return (
    <section className="dsh-interaction" role="group" aria-labelledby={`approval-${props.request.id}`}>
      <header className="dsh-interaction__header">
        <span className="dsh-interaction__icon" aria-hidden="true">
          <Icon name="alert" />
        </span>
        <div>
          <span className="dsh-app__eyebrow">{t('approval.required')}</span>
          <h2 id={`approval-${props.request.id}`}>{props.request.title}</h2>
        </div>
      </header>
      <ContentFlow as="p" className="dsh-interaction__description">
        {description}
      </ContentFlow>
      <div className="dsh-approval__takeover" role="status">
        <span>{t('approval.takeover')}</span>
        {props.command === undefined ? null : <code>{props.command}</code>}
      </div>
      <p className="dsh-interaction__risk">
        {t('approval.risk')}{' '}
        <span className={`dsh-status-pill dsh-status-pill--${props.request.risk}`}>
          {t(`approval.risk.${props.request.risk}`)}
        </span>
      </p>
      <div className="dsh-interaction__actions">
        {props.request.options.map((option) => (
          <button
            // The safe action carries the primary treatment; a deny must not
            // read as an equally weighted sibling of an approval.
            className={`dsh-button ${option.kind === 'deny' ? 'dsh-button--secondary' : 'dsh-button--primary'}`}
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
})
