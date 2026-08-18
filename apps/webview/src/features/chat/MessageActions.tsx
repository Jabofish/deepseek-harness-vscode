import type { ReactElement } from 'react'
import { useI18n, type Translate } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { CopyButton } from './CopyButton.js'

export interface MessageActionsProps {
  readonly text: string
  readonly onBranch?: (() => void) | undefined
  readonly branchUnavailable?: boolean | undefined
  readonly translate?: Translate
}

/** Copy and branch controls shared by user and assistant transcript rows. */
export function MessageActions(props: MessageActionsProps): ReactElement {
  const { t } = useI18n()
  const translate = props.translate ?? t
  const branchUnavailable = props.branchUnavailable === true
  return (
    <div className="dsh-message-actions" role="toolbar" aria-label={translate('message.actions')}>
      <CopyButton text={props.text} className="dsh-message-actions__button" translate={translate} />
      {props.onBranch === undefined ? null : (
        <button
          className="dsh-message-actions__button"
          type="button"
          aria-label={translate('message.branch')}
          aria-disabled={branchUnavailable || undefined}
          title={branchUnavailable ? translate('message.branchUnavailable') : translate('message.branch')}
          onClick={branchUnavailable ? undefined : props.onBranch}
        >
          <Icon name="branch" />
        </button>
      )}
    </div>
  )
}
