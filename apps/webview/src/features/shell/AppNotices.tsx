import { useId, useRef, useState, type ReactElement } from 'react'
import { useI18n } from '../../i18n.js'
import { Icon, type IconName } from '../../ui/Icon.js'

export interface AppNotice {
  readonly id: string
  readonly tone: 'danger' | 'warning' | 'info'
  readonly title: string
  readonly message?: string
  readonly dismissLabel: string
  readonly onDismiss: () => void
  readonly action?: { readonly label: string; readonly icon: IconName; readonly run: () => void }
}

/** Persistent notices reserve a compact row; only the user expands their details. */
export function AppNotices({ notices }: { readonly notices: readonly AppNotice[] }): ReactElement | null {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const primary = notices[0]
  if (primary === undefined) return null

  return (
    <section
      className="dsh-app__notices"
      aria-label={t('app.notices')}
      onKeyDown={(event) => {
        if (!expanded || event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        setExpanded(false)
        toggleRef.current?.focus()
      }}
    >
      <div className={`dsh-app__notice-summary dsh-app__notice--${primary.tone}`}>
        <div
          className="dsh-app__notice-copy"
          role={primary.tone === 'danger' ? 'alert' : 'status'}
          aria-atomic="true"
          title={[primary.title, primary.message].filter(Boolean).join(' · ')}
        >
          <strong>{primary.title}</strong>
          {primary.message === undefined ? null : <span>{primary.message}</span>}
        </div>
        {expanded || primary.action === undefined ? null : (
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={primary.action.label}
            title={primary.action.label}
            onClick={primary.action.run}
          >
            <Icon name={primary.action.icon} />
          </button>
        )}
        <button
          ref={toggleRef}
          className="dsh-app__notice-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={expanded ? detailsId : undefined}
          aria-label={t(expanded ? 'app.hideNotices' : 'app.showNotices', { count: notices.length })}
          title={t(expanded ? 'app.hideNotices' : 'app.showNotices', { count: notices.length })}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{notices.length}</span>
          <Icon name="chevron-down" />
        </button>
        {expanded ? null : (
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={primary.dismissLabel}
            title={primary.dismissLabel}
            onClick={primary.onDismiss}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      {expanded ? (
        <div id={detailsId} className="dsh-app__notice-list">
          {notices.map((notice) => (
            <article className={`dsh-app__notice dsh-app__notice--${notice.tone}`} key={notice.id}>
              <div>
                <strong>{notice.title}</strong>
                {notice.message === undefined ? null : <p>{notice.message}</p>}
                {notice.action === undefined ? null : (
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    onClick={notice.action.run}
                  >
                    {notice.action.label}
                  </button>
                )}
              </div>
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={notice.dismissLabel}
                title={notice.dismissLabel}
                onClick={() => {
                  toggleRef.current?.focus()
                  notice.onDismiss()
                }}
              >
                <Icon name="close" />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}
