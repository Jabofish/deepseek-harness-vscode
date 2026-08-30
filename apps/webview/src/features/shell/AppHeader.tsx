import type { ReactElement, ReactNode } from 'react'
import type { WebviewBackendState } from '../../app/store.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'
import { RuntimeStatus } from '../runtime/RuntimeStatus.js'
import { SessionHeader } from './SessionHeader.js'

export interface AppHeaderProps {
  readonly runtime: WebviewBackendState
  readonly connectedDshVersion?: string | undefined
  readonly compatibilityWarning?: string | undefined
  readonly sessionControl: ReactNode
  readonly onNewSession: () => void
  readonly onOpenSettings: () => void
  readonly onRetryConnection: () => void
}

/** Compact utility controls placed in the conversation toolbar. */
export function AppHeader(props: AppHeaderProps): ReactElement {
  const { t } = useI18n()
  return (
    <header className="dsh-conversation__utility" aria-label={t('app.conversation')}>
      <div className="dsh-conversation__utility-session">
        <SessionHeader sessionControl={props.sessionControl} onNewSession={props.onNewSession} />
      </div>
      <RuntimeStatus
        state={props.runtime}
        connectedDshVersion={props.connectedDshVersion}
        compatibilityWarning={props.compatibilityWarning}
        onOpenSettings={props.onOpenSettings}
        onRetry={props.onRetryConnection}
      />
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
