import type { ReactElement, ReactNode } from 'react'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface SessionHeaderProps {
  readonly sessionControl: ReactNode
  readonly onNewSession: () => void
}

/** The single session control cluster in the application chrome. */
export function SessionHeader(props: SessionHeaderProps): ReactElement {
  const { t } = useI18n()
  return (
    <div className="dsh-session-header">
      <div className="dsh-session-header__switcher">{props.sessionControl}</div>
      <button
        className="dsh-icon-button dsh-session-header__create"
        type="button"
        aria-label={t('sessions.new')}
        title={t('sessions.new')}
        onClick={props.onNewSession}
      >
        <Icon name="add" />
      </button>
    </div>
  )
}
