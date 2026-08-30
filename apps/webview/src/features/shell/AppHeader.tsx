import type { ReactElement, ReactNode } from 'react'
import type { BackendState } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { RuntimeStatus } from '../runtime/RuntimeStatus.js'
import { SessionHeader } from './SessionHeader.js'

export interface AppHeaderProps {
  readonly runtime: BackendState
  readonly sessionControl: ReactNode
  readonly onNewSession: () => void
  readonly onOpenSettings: () => void
}

/** Compact utility controls placed in the conversation toolbar. */
export function AppHeader(props: AppHeaderProps): ReactElement {
  const { t } = useI18n()
  return (
    <header className="dsh-conversation__utility" aria-label={t('app.conversation')}>
      <div className="dsh-conversation__utility-session">
        <SessionHeader sessionControl={props.sessionControl} onNewSession={props.onNewSession} />
      </div>
      <RuntimeStatus state={props.runtime} />
      <button
        className="dsh-icon-button"
        type="button"
        aria-label={t('settings.title')}
        title={t('settings.title')}
        onClick={props.onOpenSettings}
      >
        <Icon name="settings" />
      </button>
    </header>
  )
}
