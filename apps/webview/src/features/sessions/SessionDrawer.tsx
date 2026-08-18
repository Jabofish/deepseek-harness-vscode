import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { displaySessionTitle } from './session-title.js'
import { useI18n } from '../../i18n.js'

export interface SessionDrawerProps {
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  readonly open?: boolean
  readonly onOpenChange?: (open: boolean) => void
  readonly showTrigger?: boolean
  readonly onOpen: (sessionId: string) => void
  readonly onCreate: (workspaceId: string | undefined) => void
  readonly onArchive: (sessionId: string) => Promise<void>
  readonly onSearch: (query: string) => Promise<readonly SessionSummary[]>
}

type SessionSorting = 'manual' | 'updated'

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_RESULT_LIMIT = 20

export function SessionDrawer(props: SessionDrawerProps): ReactElement {
  const { t } = useI18n()
  const { onSearch } = props
  const [internalOpen, setInternalOpen] = useState(false)
  const [removingSessionId, setRemovingSessionId] = useState<string>()
  const [searchQuery, setSearchQuery] = useState('')
  const [contentSearch, setContentSearch] = useState<{
    readonly query: string
    readonly matches: readonly SessionSummary[]
  }>({ query: '', matches: [] })
  const [sorting, setSorting] = useState<SessionSorting>('manual')
  const searchSequence = useRef(0)
  const panelId = useId()
  const isControlled = props.open !== undefined
  const open = props.open ?? internalOpen
  const showTrigger = props.showTrigger !== false
  const setOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const resolved = typeof next === 'function' ? next(open) : next
    if (!isControlled) setInternalOpen(resolved)
    props.onOpenChange?.(resolved)
  }
  const activeSession = props.sessions.find((session) => session.id === props.activeSessionId)
  const currentWorkspace =
    props.workspaces.find((workspace) => workspace.id === activeSession?.workspaceId) ?? props.workspaces[0]
  const currentWorkspaceId = currentWorkspace?.id
  const trimmedSearchQuery = searchQuery.trim()
  const contentMatches = contentSearch.query === trimmedSearchQuery ? contentSearch.matches : []
  const query = trimmedSearchQuery.toLowerCase()
  const workspaceSessions =
    currentWorkspace === undefined
      ? []
      : props.sessions.filter(
          (session) =>
            (session.workspaceId === currentWorkspace.id ||
              currentWorkspace.sessionIds?.includes(session.id)) &&
            (!session.blank || session.id === props.activeSessionId),
        )
  // Instant local title filtering keeps the list responsive while the host
  // content search debounces behind it, mirroring the official sidebar.
  const visibleSessions =
    query === ''
      ? sortSessions(workspaceSessions, sorting)
      : sortSessions(
          workspaceSessions.filter((session) =>
            displaySessionTitle(session.title, t).toLowerCase().includes(query),
          ),
          sorting,
        )

  useEffect(() => {
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    if (trimmedSearchQuery === '') return
    const timer = window.setTimeout(() => {
      void onSearch(trimmedSearchQuery)
        .then((matches) => {
          if (searchSequence.current !== sequence) return
          setContentSearch({
            query: trimmedSearchQuery,
            matches: matches.slice(0, SEARCH_RESULT_LIMIT),
          })
        })
        .catch(() => {
          if (searchSequence.current !== sequence) return
          setContentSearch({ query: trimmedSearchQuery, matches: [] })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [trimmedSearchQuery, onSearch])

  const visibleIds = new Set(visibleSessions.map((session) => session.id))
  const otherWorkspaceMatches = sortSessions(
    contentMatches.filter(
      (session) => !visibleIds.has(session.id) && !session.blank && session.id !== props.activeSessionId,
    ),
    sorting,
  )

  const openSession = (sessionId: string): void => {
    setOpen(false)
    props.onOpen(sessionId)
  }

  const archiveSession = (session: SessionSummary): void => {
    setRemovingSessionId(session.id)
    void props
      .onArchive(session.id)
      .catch(() => undefined)
      .finally(() => setRemovingSessionId((current) => (current === session.id ? undefined : current)))
  }

  const renderSessionRow = (session: SessionSummary, workspaceName: string | undefined): ReactElement => {
    const title = displaySessionTitle(session.title, t)
    const statusLabel = t(`sessions.status.${session.status}`)
    return (
      <li key={session.id} aria-busy={removingSessionId === session.id}>
        <button
          className={`dsh-session-item__button${session.id === props.activeSessionId ? ' dsh-session-item__button--active' : ''}`}
          type="button"
          aria-current={session.id === props.activeSessionId ? 'page' : undefined}
          disabled={removingSessionId !== undefined}
          onClick={() => openSession(session.id)}
        >
          <span
            className={`dsh-session-item__icon dsh-session-item__icon--${session.status}`}
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
          >
            <Icon name={sessionStatusIcon(session.status)} />
          </span>
          <span className="dsh-session-item__copy">
            <strong title={title}>{title}</strong>
            {workspaceName === undefined ? null : (
              <span className="dsh-session-item__workspace" title={workspaceName}>
                {workspaceName}
              </span>
            )}
          </span>
        </button>
        {session.blank ? null : (
          <button
            className="dsh-icon-button dsh-session-item__remove"
            type="button"
            aria-label={t('sessions.archive', { title })}
            title={t('sessions.archiveTitle')}
            disabled={removingSessionId !== undefined}
            onClick={() => archiveSession(session)}
          >
            <Icon name="box" />
          </button>
        )}
      </li>
    )
  }

  return (
    <section
      className={`dsh-session-switcher${showTrigger ? '' : ' dsh-session-switcher--headless'}`}
      aria-labelledby="sessions-title"
    >
      <h2 id="sessions-title" className="dsh-sr-only">
        {t('sessions.title')}
      </h2>
      {showTrigger ? (
        <button
          className={`dsh-session-switcher__trigger${open ? ' dsh-session-switcher__trigger--open' : ''}`}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-haspopup="dialog"
          aria-label={
            activeSession === undefined
              ? t('sessions.open')
              : t('sessions.switch', { title: displaySessionTitle(activeSession.title, t) })
          }
          title={
            activeSession === undefined ? t('sessions.open') : displaySessionTitle(activeSession.title, t)
          }
          onClick={() => setOpen((current) => !current)}
        >
          <span className="dsh-session-switcher__icon" aria-hidden="true">
            <Icon name="session" />
          </span>
          <span className="dsh-sr-only">
            {activeSession === undefined
              ? (currentWorkspace?.name ?? t('sessions.open'))
              : displaySessionTitle(activeSession.title, t)}
          </span>
          <span className="dsh-session-switcher__chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      {open ? (
        <div
          id={panelId}
          className="dsh-session-switcher__panel"
          role="dialog"
          aria-label={t('sessions.title')}
        >
          <header className="dsh-session-switcher__panel-header">
            <span
              className="dsh-session-switcher__panel-title"
              title={currentWorkspace?.name ?? t('sessions.title')}
            >
              {currentWorkspace?.name ?? t('sessions.title')}
            </span>
            <div className="dsh-session-switcher__panel-actions">
              <button
                className="dsh-icon-button"
                type="button"
                aria-label={sorting === 'manual' ? t('sessions.sortUpdated') : t('sessions.sortManual')}
                title={sorting === 'manual' ? t('sessions.sortUpdatedTitle') : t('sessions.sortManualTitle')}
                onClick={() => setSorting((current) => (current === 'manual' ? 'updated' : 'manual'))}
              >
                <Icon name={sorting === 'manual' ? 'list' : 'clock'} />
              </button>
              <button
                className="dsh-button dsh-button--primary dsh-button--compact"
                type="button"
                aria-label={t('sessions.new')}
                title={t('sessions.new')}
                onClick={() => {
                  setOpen(false)
                  props.onCreate(currentWorkspaceId)
                }}
              >
                <Icon name="add" />
                <span className="dsh-sr-only">{t('sessions.new')}</span>
              </button>
            </div>
          </header>
          <div className="dsh-session-switcher__search">
            <input
              type="search"
              value={searchQuery}
              placeholder={t('sessions.search')}
              aria-label={t('sessions.searchAria')}
              onChange={(event) => setSearchQuery(event.target.value)}
            />
          </div>
          {currentWorkspace === undefined && query === '' ? (
            <p className="dsh-session-switcher__empty">{t('sessions.temporary')}</p>
          ) : visibleSessions.length === 0 && otherWorkspaceMatches.length === 0 ? (
            <p className="dsh-session-switcher__empty">
              {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
            </p>
          ) : (
            <>
              <ul className="dsh-session-switcher__list" aria-label={t('sessions.title')}>
                {visibleSessions.map((session) => renderSessionRow(session, undefined))}
              </ul>
              {otherWorkspaceMatches.length === 0 ? null : (
                <>
                  <p className="dsh-session-switcher__group-label">{t('sessions.contentMatches')}</p>
                  <ul className="dsh-session-switcher__list" aria-label={t('sessions.otherMatches')}>
                    {otherWorkspaceMatches.map((session) =>
                      renderSessionRow(
                        session,
                        props.workspaces.find((workspace) => workspace.id === session.workspaceId)?.name,
                      ),
                    )}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

function sortSessions(
  sessions: readonly SessionSummary[],
  sorting: SessionSorting,
): readonly SessionSummary[] {
  if (sorting === 'manual') return sessions
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function sessionStatusIcon(status: SessionSummary['status']): 'alert' | 'check' | 'clock' | 'play' {
  switch (status) {
    case 'running':
      return 'play'
    case 'completed':
      return 'check'
    case 'failed':
    case 'awaiting-input':
      return 'alert'
    case 'idle':
      return 'clock'
  }
}
