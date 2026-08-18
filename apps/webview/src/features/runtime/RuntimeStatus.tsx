import type { ReactElement } from 'react'
import type { BackendState } from '@dsh-vscode/domain'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export function RuntimeStatus({ state }: { readonly state: BackendState }): ReactElement {
  const { t } = useI18n()
  const label =
    state.kind === 'connected'
      ? t('runtime.status.connected')
      : state.kind === 'runtime-missing'
        ? t('runtime.status.runtime-missing')
        : state.kind === 'failed' || state.kind === 'port-conflict'
          ? t('runtime.status.connection-failed')
          : t(`runtime.status.${state.kind}`)
  return (
    <div
      className={`dsh-runtime-status dsh-runtime-status--${state.kind}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={state.kind === 'failed' || state.kind === 'port-conflict' ? state.message : label}
    >
      <Icon name="status" className="dsh-runtime-status__dot" />
      <span className="dsh-sr-only">{label}</span>
    </div>
  )
}
