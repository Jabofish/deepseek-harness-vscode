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
  readonly contentPending?: boolean
  readonly contentFailed?: boolean
  readonly onRespond: (optionId: string) => void
}

// A pending card docks in the composer slot for as long as the conversation
// streams behind it; memo keeps those frames from re-rendering the card.
export const ApprovalCard = memo(function ApprovalCard(props: ApprovalCardProps): ReactElement {
  const { locale, t } = useI18n()
  const description =
    props.request.displayReason?.[locale] ?? props.request.displayReason?.en ?? props.request.description
  return (
    <section
      className="dsh-interaction dsh-interaction--approval"
      role="group"
      aria-labelledby={`approval-${props.request.id}`}
    >
      <header className="dsh-interaction__header">
        <span className="dsh-interaction__icon" aria-hidden="true">
          <Icon name="alert" />
        </span>
        <div>
          <h2 id={`approval-${props.request.id}`} tabIndex={0}>
            {props.request.title}
          </h2>
        </div>
        <span className="dsh-approval__risk">
          {t('approval.risk')}{' '}
          <span className={`dsh-status-pill dsh-status-pill--${props.request.risk}`}>
            {t(`approval.risk.${props.request.risk}`)}
          </span>
        </span>
      </header>
      <div className="dsh-interaction__body" tabIndex={0}>
        {props.contentPending === true ? (
          <p role="status">
            {t(props.contentFailed === true ? 'approval.loadingFailed' : 'approval.loadingRequest')}
          </p>
        ) : null}
        <ContentFlow as="p" className="dsh-interaction__description">
          {description}
        </ContentFlow>
        {props.command === undefined ? null : (
          <pre className="dsh-approval__command">
            <code>{props.command}</code>
          </pre>
        )}
      </div>
      <div className="dsh-interaction__actions">
        {props.request.options.map((option) => (
          <button
            // The safe action carries the primary treatment; a deny must not
            // read as an equally weighted sibling of an approval.
            className={`dsh-button dsh-button--compact ${option.kind === 'deny' ? 'dsh-button--secondary' : 'dsh-button--primary'}`}
            key={option.id}
            type="button"
            disabled={props.disabled || (props.contentPending === true && option.kind !== 'deny')}
            onClick={() => props.onRespond(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  )
})
