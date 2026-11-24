import { useEffect, useState, type ReactElement } from 'react'
import { SettingCard } from '../../components/common/SettingCard.js'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface ExtensionSettingsCardProps {
  /** Opens VS Code's Settings editor filtered to this extension. */
  readonly onOpen: () => Promise<void>
  /** Forgets the stored external-connection token, then reconnects. */
  readonly onClearCredentials?: () => Promise<void>
}

/** Connection, runtime, checkpoint and editor options live in VS Code
 * settings; this card is the in-app path to them. */
export function ExtensionSettingsCard(props: ExtensionSettingsCardProps): ReactElement {
  const { t } = useI18n()
  const [busy, setBusy] = useState<'open' | 'clear' | undefined>()
  const [error, setError] = useState<string>()
  const [confirming, setConfirming] = useState(false)
  const [cleared, setCleared] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 4_000)
    return () => window.clearTimeout(timer)
  }, [confirming])
  const run = (kind: 'open' | 'clear', action: () => Promise<void>, fallback: string): void => {
    if (busy !== undefined) return
    setBusy(kind)
    setError(undefined)
    setCleared(false)
    void action()
      .then(() => {
        if (kind === 'clear') setCleared(true)
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : fallback))
      .finally(() => setBusy(undefined))
  }
  return (
    <SettingCard ariaLabel={t('settings.extension.title')} title={t('settings.extension.title')}>
      <p className="dsh-settings__description">{t('settings.extension.hint')}</p>
      <div className="dsh-settings__document-action">
        <button
          className="dsh-button dsh-button--secondary dsh-button--compact"
          type="button"
          disabled={busy !== undefined}
          onClick={() => run('open', props.onOpen, t('settings.extension.openFailed'))}
        >
          <Icon name="settings" />
          {t('settings.extension.open')}
        </button>
        {props.onClearCredentials === undefined ? null : (
          <button
            className="dsh-button dsh-button--ghost dsh-button--compact"
            type="button"
            disabled={busy !== undefined}
            onBlur={() => setConfirming(false)}
            onClick={() => {
              // The stored token cannot be recovered; the first press asks.
              if (!confirming) {
                setConfirming(true)
                return
              }
              setConfirming(false)
              const clear = props.onClearCredentials
              if (clear !== undefined) run('clear', clear, t('settings.extension.clearFailed'))
            }}
          >
            {t(confirming ? 'settings.extension.clearConfirm' : 'settings.extension.clear')}
          </button>
        )}
        {error === undefined ? null : (
          <span className="dsh-settings__error" role="alert">
            {error}
          </span>
        )}
        {cleared ? <span role="status">{t('settings.extension.cleared')}</span> : null}
      </div>
    </SettingCard>
  )
}
