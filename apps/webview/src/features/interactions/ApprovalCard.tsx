import { memo, type ReactElement } from 'react'
import type { PermissionRequest } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { useI18n } from '../../i18n.js'
import { ContentFlow } from '../../components/common/ContentFlow.js'
import { CopyButton } from '../chat/CopyButton.js'

export interface ApprovalCardProps {
  readonly request: PermissionRequest
  readonly disabled: boolean
  /** Command the request asks to authorize, resolved from the paired call. */
  readonly command?: string
  /** Workspace-relative paths the paired call touches. */
  readonly paths?: readonly string[]
  /** Non-terminal tool input summary, so file/MCP/network approvals are not blind. */
  readonly summary?: string
  readonly contentPending?: boolean
  readonly contentFailed?: boolean
  readonly onRespond: (optionId: string) => void
}

function localizedOptionLabel(
  option: PermissionRequest['options'][number],
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (option.id === 'allowed-once' && option.label === 'Allow once') return t('approval.option.allowOnce')
  if (option.id === 'rejected' && option.label === 'Reject') return t('approval.option.reject')
  return option.label
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
        {props.request.risk === 'unknown' ? null : (
          <span className="dsh-approval__risk">
            {t('approval.risk')}{' '}
            <span className={`dsh-status-pill dsh-status-pill--${props.request.risk}`}>
              {t(`approval.risk.${props.request.risk}`)}
            </span>
          </span>
        )}
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
        {props.paths === undefined || props.paths.length === 0 ? null : (
          <div className="dsh-approval__meta">
            <strong>{t('approval.targets')}:</strong> <code>{props.paths.join(', ')}</code>
          </div>
        )}
        {props.command === undefined ? null : (
          <div className="dsh-approval__command-container">
            <pre className="dsh-approval__command">
              <code>{props.command}</code>
            </pre>
            <CopyButton
              text={props.command}
              className="dsh-icon-button dsh-approval__command-copy"
              translate={t}
            />
          </div>
        )}
        {props.summary === undefined ? null : (
          <div className="dsh-approval__command-container">
            <pre className="dsh-approval__command" aria-label={t('approval.details')}>
              <code>{props.summary}</code>
            </pre>
            <CopyButton
              text={props.summary}
              className="dsh-icon-button dsh-approval__command-copy"
              translate={t}
            />
          </div>
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
            {localizedOptionLabel(option, t)}
          </button>
        ))}
      </div>
    </section>
  )
})
