import type { ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { Icon } from '../../ui/Icon.js'

export interface RuntimeMissingViewProps {
  readonly searchedLocations: readonly string[]
  readonly busyAction: 'install' | 'select' | undefined
  readonly onAction: (action: 'install' | 'select' | 'copy-command' | 'open-docs') => void
  readonly onRetry?: () => void
  readonly onOpenSettings?: () => void
}

export function RuntimeMissingView(props: RuntimeMissingViewProps): ReactElement {
  const { t } = useI18n()
  const searchedLocations = [...new Set(props.searchedLocations.filter((location) => location.trim() !== ''))]
  return (
    <section className="dsh-runtime-missing" aria-labelledby="runtime-missing-title">
      <div className="dsh-runtime-missing__intro">
        <span className="dsh-app__eyebrow">{t('runtime.eyebrow')}</span>
        <div className="dsh-runtime-missing__title-row">
          <span className="dsh-runtime-missing__icon" aria-hidden="true">
            <Icon name="box" />
          </span>
          <h1 id="runtime-missing-title">{t('runtime.title')}</h1>
        </div>
        <p className="dsh-runtime-missing__description">{t('runtime.description')}</p>
      </div>
      <ol className="dsh-runtime-missing__steps" aria-label={t('runtime.steps')}>
        <li>{t('runtime.step.install')}</li>
        <li>{t('runtime.step.reconnect')}</li>
        <li>{t('runtime.step.docs')}</li>
      </ol>
      <div className="dsh-runtime-missing__actions">
        <button
          className="dsh-button dsh-button--primary"
          type="button"
          disabled={props.busyAction === 'install'}
          onClick={() => props.onAction('install')}
        >
          {props.busyAction === 'install' ? t('runtime.installing') : t('runtime.install')}
        </button>
        <button
          className="dsh-button dsh-button--secondary"
          type="button"
          disabled={props.busyAction === 'select'}
          onClick={() => props.onAction('select')}
        >
          {props.busyAction === 'select' ? t('runtime.selecting') : t('runtime.select')}
        </button>
        <button
          className="dsh-button dsh-button--ghost"
          type="button"
          onClick={() => props.onAction('copy-command')}
        >
          {t('runtime.copy')}
        </button>
        <button className="dsh-button dsh-button--ghost" type="button" onClick={props.onRetry}>
          {t('runtime.retry')}
        </button>
        {props.onOpenSettings === undefined ? null : (
          <button className="dsh-button dsh-button--ghost" type="button" onClick={props.onOpenSettings}>
            {t('runtime.openSettings')}
          </button>
        )}
        <button
          className="dsh-button dsh-button--ghost"
          type="button"
          onClick={() => props.onAction('open-docs')}
        >
          {t('runtime.docs')}
        </button>
      </div>
      <details>
        <summary>{t('runtime.searched', { count: searchedLocations.length })}</summary>
        <ul>
          {searchedLocations.map((location) => (
            <li key={location}>
              <code>{location}</code>
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
