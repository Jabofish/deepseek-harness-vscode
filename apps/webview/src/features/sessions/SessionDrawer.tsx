import { useId, useState, type ReactElement } from 'react'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { Icon } from '../../ui/Icon.js'
import { displaySessionTitle } from './session-title.js'

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
}

export function SessionDrawer(props: SessionDrawerProps): ReactElement {
  const [internalOpen, setInternalOpen] = useState(false)
  const [removingSessionId, setRemovingSessionId] = useState<string>()
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
  const visibleSessions =
    currentWorkspace === undefined
      ? []
      : props.sessions.filter(
          (session) =>
            (session.workspaceId === currentWorkspace.id ||
              currentWorkspace.sessionIds?.includes(session.id)) &&
            (!session.blank || session.id === props.activeSessionId),
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

  return (
    <section
      className={`dsh-session-switcher${showTrigger ? '' : ' dsh-session-switcher--headless'}`}
      aria-labelledby="sessions-title"
    >
      <h2 id="sessions-title" className="dsh-sr-only">
        Sessions
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
              ? 'Open sessions'
              : `Switch session: ${displaySessionTitle(activeSession.title)}`
          }
          title={activeSession === undefined ? 'Open sessions' : displaySessionTitle(activeSession.title)}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="dsh-session-switcher__icon" aria-hidden="true">
            <Icon name="session" />
          </span>
          <span className="dsh-sr-only">
            {activeSession === undefined
              ? (currentWorkspace?.name ?? 'Open sessions')
              : displaySessionTitle(activeSession.title)}
          </span>
          <span className="dsh-session-switcher__chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      {open ? (
        <div id={panelId} className="dsh-session-switcher__panel" role="dialog" aria-label="Sessions">
          <header className="dsh-session-switcher__panel-header">
            <span className="dsh-session-switcher__panel-title" title={currentWorkspace?.name ?? 'Sessions'}>
              {currentWorkspace?.name ?? 'Sessions'}
            </span>
            <button
              className="dsh-button dsh-button--primary dsh-button--compact"
              type="button"
              aria-label="New Session"
              title="New Session"
              onClick={() => {
                setOpen(false)
                props.onCreate(currentWorkspaceId)
              }}
            >
              <Icon name="add" />
              <span className="dsh-sr-only">New Session</span>
            </button>
          </header>
          {currentWorkspace === undefined ? (
            <p className="dsh-session-switcher__empty">New Session will create a temporary workspace.</p>
          ) : visibleSessions.length === 0 ? (
            <p className="dsh-session-switcher__empty">No sessions in this workspace.</p>
          ) : (
            <ul className="dsh-session-switcher__list" aria-label="Sessions">
              {visibleSessions.map((session) => {
                const title = displaySessionTitle(session.title)
                const statusLabel = sessionStatusLabel(session.status)
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
                      </span>
                    </button>
                    {session.blank ? null : (
                      <button
                        className="dsh-icon-button dsh-session-item__remove"
                        type="button"
                        aria-label={`Archive session ${title}`}
                        title="Archive session"
                        disabled={removingSessionId !== undefined}
                        onClick={() => archiveSession(session)}
                      >
                        <Icon name="box" />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
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

function sessionStatusLabel(status: SessionSummary['status']): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'completed':
      return 'Completed'
    case 'failed':
      return 'Failed'
    case 'awaiting-input':
      return 'Waiting for input'
    case 'idle':
      return 'Idle'
  }
}
