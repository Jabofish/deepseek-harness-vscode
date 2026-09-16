import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import type { SessionSummary, WorkspaceSummary } from '@dsh-vscode/domain'
import { PopoverCard } from '../../components/common/PopoverCard.js'
import { useDismissibleLayer } from '../../components/common/useDismissibleLayer.js'
import { Icon } from '../../ui/Icon.js'
import { displaySessionTitle } from './session-title.js'
import { useI18n } from '../../i18n.js'

export interface SessionDrawerProps {
  readonly sessions: readonly SessionSummary[]
  readonly workspaces: readonly WorkspaceSummary[]
  readonly activeSessionId: string | undefined
  /** Omitted or `undefined` leaves the switcher uncontrolled: it owns `open`. */
  readonly open?: boolean | undefined
  readonly onOpenChange?: (open: boolean) => void
  readonly showTrigger?: boolean
  readonly onOpen: (sessionId: string) => void
  readonly onCreate: (workspaceId: string | undefined) => void
  readonly onArchive: (sessionId: string) => Promise<void>
  readonly onRename: (sessionId: string, title: string) => Promise<void>
  readonly onRenameWorkspace: (workspaceId: string, name: string) => Promise<void>
  readonly onRemoveWorkspace: (workspaceId: string) => Promise<void>
  readonly onMoveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => Promise<void>
  readonly onMoveSession: (workspaceId: string, sessionId: string, beforeSessionId?: string) => Promise<void>
  readonly onSearch: (query: string) => Promise<readonly SessionSummary[]>
}

type SessionSorting = 'manual' | 'updated'
type WorkspaceDisplay = 'current' | 'grouped'
type RenameTarget =
  | { readonly kind: 'session'; readonly id: string; readonly title: string; readonly workspaceId: string }
  | { readonly kind: 'workspace'; readonly id: string; readonly title: string }

const SEARCH_DEBOUNCE_MS = 250
const SEARCH_RESULT_LIMIT = 20
/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 500
const ORDER_DRAG_MIME = 'application/x-dsh-order'

type OrderDrag =
  | { readonly kind: 'workspace'; readonly itemId: string }
  | { readonly kind: 'session'; readonly workspaceId: string; readonly itemId: string }

/**
 * Keep the controlled input and the request inside the `session.search` wire
 * contract: the host refuses a query carrying a NUL or one over the code-unit
 * bound, and a query the field never let through cannot be sent in error.
 */
function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\u0000', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  // Never cut a surrogate pair in half: half a pair is not a character.
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1
  return withoutNul.slice(0, end)
}

function readOrderDrag(dataTransfer: DataTransfer): OrderDrag | undefined {
  try {
    const value: unknown = JSON.parse(dataTransfer.getData(ORDER_DRAG_MIME))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.kind === 'workspace' && typeof record.itemId === 'string' && record.itemId !== '')
      return { kind: 'workspace', itemId: record.itemId }
    if (
      record.kind === 'session' &&
      typeof record.workspaceId === 'string' &&
      record.workspaceId !== '' &&
      typeof record.itemId === 'string' &&
      record.itemId !== ''
    )
      return { kind: 'session', workspaceId: record.workspaceId, itemId: record.itemId }
  } catch {
    return undefined
  }
  return undefined
}

export const SessionDrawer = memo(function SessionDrawer(props: SessionDrawerProps): ReactElement {
  const { t } = useI18n()
  const { onSearch } = props
  const [internalOpen, setInternalOpen] = useState(false)
  const [removingSessionId, setRemovingSessionId] = useState<string>()
  const [searchQuery, setSearchQuery] = useState('')
  const [contentSearch, setContentSearch] = useState<{
    readonly query: string
    readonly matches: readonly SessionSummary[]
  }>({ query: '', matches: [] })
  const [contentSearchUnavailable, setContentSearchUnavailable] = useState(false)
  const [sorting, setSorting] = useState<SessionSorting>('manual')
  const [workspaceDisplay, setWorkspaceDisplay] = useState<WorkspaceDisplay>('current')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>()
  const [renameTarget, setRenameTarget] = useState<RenameTarget>()
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string>()
  const [removeWorkspace, setRemoveWorkspace] = useState<WorkspaceSummary>()
  const [removeError, setRemoveError] = useState<string>()
  const [moveError, setMoveError] = useState<string>()
  const [mutationBusy, setMutationBusy] = useState(false)
  const searchSequence = useRef(0)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const renameDialogRef = useRef<HTMLFormElement>(null)
  const removeDialogRef = useRef<HTMLDivElement>(null)
  /** Both dialogs are portalled `aria-modal` surfaces; the row control that
   * opened one takes the keyboard back when it closes. */
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const panelId = useId()
  const renameDialogId = useId()
  const isControlled = props.open !== undefined
  const open = props.open ?? internalOpen
  const showTrigger = props.showTrigger !== false
  const setOpen = (next: boolean | ((current: boolean) => boolean)): void => {
    const resolved = typeof next === 'function' ? next(open) : next
    if (!isControlled) setInternalOpen(resolved)
    props.onOpenChange?.(resolved)
  }
  const activeSession = props.sessions.find((session) => session.id === props.activeSessionId)
  const activeWorkspace =
    props.workspaces.find((workspace) => workspace.id === activeSession?.workspaceId) ?? props.workspaces[0]
  const selectedWorkspace =
    props.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? activeWorkspace
  const selectedWorkspaceKey = selectedWorkspace?.id
  const trimmedSearchQuery = searchQuery.trim()
  const contentMatches = contentSearch.query === trimmedSearchQuery ? contentSearch.matches : []
  const query = trimmedSearchQuery.toLowerCase()
  const closeRenameDialog = useCallback((): void => {
    if (mutationBusy) return
    setRenameTarget(undefined)
    setRenameDraft('')
    setRenameError(undefined)
  }, [mutationBusy])
  const closeRemoveDialog = useCallback((): void => {
    if (mutationBusy) return
    setRemoveWorkspace(undefined)
  }, [mutationBusy])
  const closeSwitcher = (): void => {
    setOpen(false)
  }
  const closeSwitcherAndRefocus = (): void => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  // The switcher is the outer layer; its two portalled dialogs each own the
  // innermost layer, so one Escape closes the dialog and leaves the switcher
  // (and its search and scroll position) in place. The trigger belongs to the
  // layer as well: without it a real press (pointerdown then click) closes the
  // switcher on the pointerdown and the click toggles it straight back open.
  useDismissibleLayer({
    open,
    refs: [triggerRef, panelRef, renameDialogRef, removeDialogRef],
    onDismiss: closeSwitcher,
    onEscape: closeSwitcherAndRefocus,
  })
  useDismissibleLayer({
    open: renameTarget !== undefined,
    refs: [renameDialogRef],
    onDismiss: closeRenameDialog,
  })
  useDismissibleLayer({
    open: removeWorkspace !== undefined,
    refs: [removeDialogRef],
    onDismiss: closeRemoveDialog,
  })

  useEffect(() => {
    if (renameTarget === undefined) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renameTarget])

  const dialogOpen = renameTarget !== undefined || removeWorkspace !== undefined
  const dialogWasOpen = useRef(false)
  useEffect(() => {
    if (dialogWasOpen.current && !dialogOpen) {
      const target = dialogTriggerRef.current
      dialogTriggerRef.current = null
      // The renamed or removed row can be gone by now; body focus beats a
      // detached node.
      if (target !== null && target.isConnected) target.focus()
    }
    dialogWasOpen.current = dialogOpen
  }, [dialogOpen])

  const workspaceSessions = (workspace: WorkspaceSummary): readonly SessionSummary[] =>
    props.sessions.filter(
      (session) =>
        session.origin !== 'subagent' &&
        (session.workspaceId === workspace.id || workspace.sessionIds?.includes(session.id) === true) &&
        (!session.blank || session.id === props.activeSessionId),
    )

  const filterSessions = (workspace: WorkspaceSummary): readonly SessionSummary[] => {
    const sessions = workspaceSessions(workspace)
    const filtered =
      query === ''
        ? sessions
        : sessions.filter((session) => displaySessionTitle(session.title, t).toLowerCase().includes(query))
    return sortSessions(filtered, sorting, workspace.sessionIds, props.activeSessionId)
  }

  const currentWorkspaceSessions =
    workspaceDisplay === 'current' && selectedWorkspace !== undefined ? filterSessions(selectedWorkspace) : []
  const groupedWorkspaceSessions =
    workspaceDisplay === 'grouped'
      ? props.workspaces.map((workspace) => ({
          workspace,
          sessions: filterSessions(workspace),
        }))
      : []
  const locallyVisibleIds = new Set(currentWorkspaceSessions.map((session) => session.id))

  useEffect(() => {
    const sequence = searchSequence.current + 1
    searchSequence.current = sequence
    setContentSearchUnavailable(false)
    if (trimmedSearchQuery === '') return
    const timer = window.setTimeout(() => {
      void onSearch(trimmedSearchQuery)
        .then((matches) => {
          if (searchSequence.current !== sequence) return
          setContentSearch({ query: trimmedSearchQuery, matches: matches.slice(0, SEARCH_RESULT_LIMIT) })
          setContentSearchUnavailable(false)
        })
        .catch(() => {
          if (searchSequence.current !== sequence) return
          // A refused content search leaves the name filter as the only result
          // source; reporting the empty list as "no matches" would claim the
          // host searched and found nothing.
          setContentSearch({ query: trimmedSearchQuery, matches: [] })
          setContentSearchUnavailable(true)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [onSearch, trimmedSearchQuery])

  const otherWorkspaceMatches =
    workspaceDisplay === 'current'
      ? sortSessions(
          contentMatches.filter(
            (session) =>
              !locallyVisibleIds.has(session.id) &&
              session.origin !== 'subagent' &&
              !session.blank &&
              session.id !== props.activeSessionId,
          ),
          sorting,
        )
      : []

  const openSession = (session: SessionSummary): void => {
    setSelectedWorkspaceId(session.workspaceId)
    setOpen(false)
    props.onOpen(session.id)
  }

  const archiveSession = (session: SessionSummary): void => {
    setRemovingSessionId(session.id)
    void props
      .onArchive(session.id)
      .catch(() => undefined)
      .finally(() => setRemovingSessionId((current) => (current === session.id ? undefined : current)))
  }

  /**
   * Reorder drops are host work like any other mutation: a refused move leaves
   * the list unchanged, so without a report the drag is indistinguishable from
   * a no-op.
   */
  const moveSession = (workspaceId: string, sessionId: string, beforeSessionId: string): void => {
    setMoveError(undefined)
    void props.onMoveSession(workspaceId, sessionId, beforeSessionId).catch((reason: unknown) => {
      setMoveError(reason instanceof Error ? reason.message : t('sessions.moveFailed'))
    })
  }

  const moveWorkspace = (workspaceId: string, beforeWorkspaceId: string): void => {
    setMoveError(undefined)
    void props.onMoveWorkspace(workspaceId, beforeWorkspaceId).catch((reason: unknown) => {
      setMoveError(reason instanceof Error ? reason.message : t('sessions.moveFailed'))
    })
  }

  const startRename = (target: RenameTarget): void => {
    setRenameTarget(target)
    setRenameDraft(target.title.trim())
    setRenameError(undefined)
  }

  const submitRename = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (renameTarget === undefined || mutationBusy) return
    const title = renameDraft.trim()
    if (title === '') {
      setRenameError(t('sessions.renameInvalid'))
      return
    }
    setMutationBusy(true)
    setRenameError(undefined)
    const operation =
      renameTarget.kind === 'session'
        ? props.onRename(renameTarget.id, title)
        : props.onRenameWorkspace(renameTarget.id, title)
    void operation
      .then(() => closeRenameDialog())
      .catch((reason: unknown) => {
        setRenameError(reason instanceof Error ? reason.message : t('sessions.renameFailed'))
      })
      .finally(() => setMutationBusy(false))
  }

  const confirmRemoveWorkspace = (): void => {
    if (removeWorkspace === undefined || mutationBusy) return
    setMutationBusy(true)
    setRemoveError(undefined)
    void props
      .onRemoveWorkspace(removeWorkspace.id)
      .then(() => {
        setSelectedWorkspaceId((current) => (current === removeWorkspace.id ? undefined : current))
        setRemoveWorkspace(undefined)
      })
      .catch((reason: unknown) => {
        setRemoveError(reason instanceof Error ? reason.message : t('sessions.workspaceRemoveFailed'))
      })
      .finally(() => setMutationBusy(false))
  }

  const renderSessionRow = (
    session: SessionSummary,
    workspaceName?: string,
    reorderWorkspaceId?: string,
  ): ReactElement => {
    const title = displaySessionTitle(session.title, t)
    const statusLabel = t(`sessions.status.${session.status}`)
    const canReorder = sorting === 'manual' && reorderWorkspaceId !== undefined
    return (
      <li
        key={session.id}
        aria-busy={removingSessionId === session.id}
        draggable={canReorder}
        title={canReorder ? t('sessions.dragSession') : undefined}
        onDragStart={(event) => {
          if (!canReorder) return
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            ORDER_DRAG_MIME,
            JSON.stringify({ kind: 'session', workspaceId: reorderWorkspaceId, itemId: session.id }),
          )
        }}
        onDragOver={(event) => {
          if (!canReorder) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          if (!canReorder) return
          const drag = readOrderDrag(event.dataTransfer)
          if (
            drag?.kind !== 'session' ||
            drag.workspaceId !== reorderWorkspaceId ||
            drag.itemId === session.id
          )
            return
          event.preventDefault()
          moveSession(reorderWorkspaceId, drag.itemId, session.id)
        }}
      >
        <button
          className={`dsh-session-item__button${session.id === props.activeSessionId ? ' dsh-session-item__button--active' : ''}`}
          type="button"
          aria-current={session.id === props.activeSessionId ? 'page' : undefined}
          disabled={removingSessionId !== undefined || mutationBusy}
          onClick={() => openSession(session)}
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
          <span
            className={`dsh-status-pill dsh-session-item__status dsh-session-item__status--${sessionStatusTone(session.status)}`}
            title={statusLabel}
          >
            <span className="dsh-session-item__status-dot" aria-hidden="true" />
            <span className="dsh-session-item__status-label">{statusLabel}</span>
          </span>
        </button>
        <div className="dsh-session-item__actions">
          <button
            className="dsh-icon-button dsh-session-item__rename"
            type="button"
            aria-label={t('sessions.rename', { title })}
            title={t('sessions.renameTitle')}
            disabled={removingSessionId !== undefined || mutationBusy}
            onClick={(event) => {
              dialogTriggerRef.current = event.currentTarget
              startRename({
                kind: 'session',
                id: session.id,
                title: session.title,
                workspaceId: session.workspaceId,
              })
            }}
          >
            <Icon name="edit" />
          </button>
          {session.blank ? null : (
            <button
              className="dsh-icon-button dsh-session-item__remove"
              type="button"
              aria-label={t('sessions.archive', { title })}
              title={t('sessions.archiveTitle')}
              disabled={removingSessionId !== undefined || mutationBusy}
              onClick={() => archiveSession(session)}
            >
              <Icon name="box" />
            </button>
          )}
        </div>
      </li>
    )
  }

  const renderWorkspaceCard = (workspace: WorkspaceSummary): ReactElement => {
    const selected = workspace.id === selectedWorkspaceKey
    return (
      <div
        className={`dsh-session-switcher__workspace${selected ? ' dsh-session-switcher__workspace--active' : ''}`}
        key={workspace.id}
        draggable={sorting === 'manual'}
        title={sorting === 'manual' ? t('sessions.dragWorkspace') : undefined}
        onDragStart={(event) => {
          if (sorting !== 'manual') return
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(
            ORDER_DRAG_MIME,
            JSON.stringify({ kind: 'workspace', itemId: workspace.id }),
          )
        }}
        onDragOver={(event) => {
          if (sorting !== 'manual') return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event) => {
          if (sorting !== 'manual') return
          const drag = readOrderDrag(event.dataTransfer)
          if (drag?.kind !== 'workspace' || drag.itemId === workspace.id) return
          event.preventDefault()
          moveWorkspace(drag.itemId, workspace.id)
        }}
      >
        <button
          className="dsh-session-switcher__workspace-button"
          type="button"
          aria-pressed={selected}
          onClick={() => {
            setSelectedWorkspaceId(workspace.id)
            setWorkspaceDisplay('current')
          }}
        >
          <span className="dsh-session-switcher__workspace-icon" aria-hidden="true">
            <Icon name="folder" />
          </span>
          <span className="dsh-session-switcher__workspace-name" title={workspace.name}>
            {workspace.name}
          </span>
          <small className="dsh-session-switcher__workspace-count">{workspace.sessionCount}</small>
        </button>
        <div className="dsh-session-switcher__workspace-actions">
          <button
            className="dsh-icon-button"
            type="button"
            aria-label={t('sessions.renameWorkspace', { name: workspace.name })}
            title={t('sessions.renameWorkspaceTitle')}
            disabled={mutationBusy}
            onClick={(event) => {
              dialogTriggerRef.current = event.currentTarget
              startRename({ kind: 'workspace', id: workspace.id, title: workspace.name })
            }}
          >
            <Icon name="edit" />
          </button>
          <button
            className="dsh-icon-button dsh-session-switcher__workspace-remove"
            type="button"
            aria-label={t('sessions.removeWorkspace', { name: workspace.name })}
            title={t('sessions.removeWorkspaceTitle')}
            disabled={mutationBusy}
            onClick={(event) => {
              dialogTriggerRef.current = event.currentTarget
              setRemoveError(undefined)
              setRemoveWorkspace(workspace)
            }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>
    )
  }

  const renameConflict =
    renameTarget === undefined
      ? false
      : renameTarget.kind === 'session'
        ? props.sessions.some(
            (session) =>
              session.id !== renameTarget.id &&
              // A row from the "content matches" list belongs to another
              // workspace; the warning names "this workspace", so it has to
              // compare inside the renamed session's own workspace.
              session.workspaceId === renameTarget.workspaceId &&
              session.title.trim().toLocaleLowerCase() === renameDraft.trim().toLocaleLowerCase() &&
              renameDraft.trim() !== '',
          )
        : props.workspaces.some(
            (workspace) =>
              workspace.id !== renameTarget.id &&
              workspace.name.trim().toLocaleLowerCase() === renameDraft.trim().toLocaleLowerCase() &&
              renameDraft.trim() !== '',
          )

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
          ref={triggerRef}
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
          onClick={() => {
            setMoveError(undefined)
            setOpen((current) => !current)
          }}
        >
          <span className="dsh-session-switcher__icon" aria-hidden="true">
            <Icon name="session" />
          </span>
          <span className="dsh-session-switcher__trigger-label">
            {activeSession === undefined
              ? (activeWorkspace?.name ?? t('sessions.open'))
              : displaySessionTitle(activeSession.title, t)}
          </span>
          <span className="dsh-session-switcher__chevron" aria-hidden="true">
            <Icon name="chevron-down" />
          </span>
        </button>
      ) : null}
      {open ? (
        <PopoverCard
          ref={panelRef}
          id={panelId}
          className="dsh-session-switcher__panel"
          role="dialog"
          aria-label={t('sessions.title')}
        >
          <header className="dsh-session-switcher__panel-header">
            <span
              className="dsh-session-switcher__panel-title"
              title={selectedWorkspace?.name ?? t('sessions.title')}
            >
              {selectedWorkspace?.name ?? t('sessions.title')}
            </span>
            <div className="dsh-session-switcher__panel-actions">
              <button
                className="dsh-icon-button"
                type="button"
                aria-pressed={workspaceDisplay === 'grouped'}
                aria-label={
                  workspaceDisplay === 'grouped'
                    ? t('sessions.showCurrentWorkspace')
                    : t('sessions.groupWorkspaces')
                }
                title={
                  workspaceDisplay === 'grouped'
                    ? t('sessions.showCurrentWorkspaceTitle')
                    : t('sessions.groupWorkspacesTitle')
                }
                onClick={() =>
                  setWorkspaceDisplay((current) => (current === 'current' ? 'grouped' : 'current'))
                }
              >
                <Icon name="folder" />
              </button>
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
                  props.onCreate(selectedWorkspaceKey)
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
              maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
              onChange={(event) => setSearchQuery(sanitizeSearchQuery(event.target.value))}
            />
          </div>
          {contentSearchUnavailable ? (
            <p className="dsh-session-switcher__warning" role="status">
              {t('sessions.searchUnavailable')}
            </p>
          ) : null}
          {moveError === undefined ? null : (
            <p className="dsh-session-switcher__error" role="alert">
              {moveError}
            </p>
          )}
          {props.workspaces.length === 0 ? null : (
            <div className="dsh-session-switcher__workspaces" aria-label={t('sessions.workspaces')}>
              {props.workspaces.map(renderWorkspaceCard)}
            </div>
          )}
          {selectedWorkspace === undefined && query === '' ? (
            <p className="dsh-session-switcher__empty">{t('sessions.temporary')}</p>
          ) : workspaceDisplay === 'grouped' ? (
            <div className="dsh-session-switcher__groups">
              {groupedWorkspaceSessions.map(({ workspace, sessions: groupSessions }) => (
                <section
                  className="dsh-session-switcher__group"
                  key={workspace.id}
                  aria-labelledby={`workspace-${workspace.id}`}
                >
                  <header className="dsh-session-switcher__group-header">
                    <strong id={`workspace-${workspace.id}`}>{workspace.name}</strong>
                    <span>{workspace.sessionCount}</span>
                  </header>
                  {groupSessions.length === 0 ? (
                    <p className="dsh-session-switcher__empty">
                      {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
                    </p>
                  ) : (
                    <ul className="dsh-session-switcher__list" aria-label={workspace.name}>
                      {groupSessions.map((session) => renderSessionRow(session, undefined, workspace.id))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          ) : currentWorkspaceSessions.length === 0 && otherWorkspaceMatches.length === 0 ? (
            <p className="dsh-session-switcher__empty">
              {query === '' ? t('sessions.empty') : t('sessions.noMatch')}
            </p>
          ) : (
            <>
              <ul className="dsh-session-switcher__list" aria-label={t('sessions.title')}>
                {currentWorkspaceSessions.map((session) =>
                  renderSessionRow(session, undefined, selectedWorkspace?.id),
                )}
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
        </PopoverCard>
      ) : null}
      {renameTarget === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <div className="dsh-session-dialog__backdrop" role="presentation">
              <form
                ref={renameDialogRef}
                className="dsh-session-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={renameDialogId}
                onSubmit={submitRename}
              >
                <h2 id={renameDialogId} className="dsh-session-dialog__title">
                  {renameTarget.kind === 'session'
                    ? t('sessions.renameTitle')
                    : t('sessions.renameWorkspaceTitle')}
                </h2>
                <label className="dsh-session-dialog__label" htmlFor={`${renameDialogId}-input`}>
                  {renameTarget.kind === 'session' ? t('sessions.sessionName') : t('sessions.workspaceName')}
                </label>
                <input
                  ref={renameInputRef}
                  id={`${renameDialogId}-input`}
                  className="dsh-session-dialog__input"
                  value={renameDraft}
                  maxLength={renameTarget.kind === 'session' ? 512 : 256}
                  onChange={(event) => setRenameDraft(event.target.value)}
                />
                {renameConflict ? (
                  <p className="dsh-session-dialog__warning" role="status">
                    {renameTarget.kind === 'session'
                      ? t('sessions.renameConflict')
                      : t('sessions.workspaceRenameConflict')}
                  </p>
                ) : null}
                {renameError === undefined ? null : (
                  <p className="dsh-session-dialog__error" role="alert">
                    {renameError}
                  </p>
                )}
                <div className="dsh-session-dialog__actions">
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    disabled={mutationBusy}
                    onClick={closeRenameDialog}
                  >
                    {t('common.cancel')}
                  </button>
                  <button className="dsh-button dsh-button--primary" type="submit" disabled={mutationBusy}>
                    {mutationBusy ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </form>
            </div>,
            document.body,
          )}
      {removeWorkspace === undefined || typeof document === 'undefined'
        ? null
        : createPortal(
            <div className="dsh-session-dialog__backdrop" role="presentation">
              <div
                ref={removeDialogRef}
                className="dsh-session-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={`${panelId}-remove-title`}
              >
                <h2 id={`${panelId}-remove-title`} className="dsh-session-dialog__title">
                  {t('sessions.removeWorkspaceTitle')}
                </h2>
                <p className="dsh-session-dialog__description">
                  {t('sessions.removeWorkspaceConfirm', {
                    name: removeWorkspace.name,
                    count: removeWorkspace.sessionCount,
                  })}
                </p>
                {removeError === undefined ? null : (
                  <p className="dsh-session-dialog__error" role="alert">
                    {removeError}
                  </p>
                )}
                <div className="dsh-session-dialog__actions">
                  <button
                    className="dsh-button dsh-button--secondary"
                    type="button"
                    disabled={mutationBusy}
                    autoFocus
                    onClick={closeRemoveDialog}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    className="dsh-button dsh-button--danger"
                    type="button"
                    disabled={mutationBusy}
                    onClick={confirmRemoveWorkspace}
                  >
                    {mutationBusy ? t('common.removing') : t('common.remove')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )}
    </section>
  )
})

function sortSessions(
  sessions: readonly SessionSummary[],
  sorting: SessionSorting,
  manualOrder?: readonly string[],
  activeSessionId?: string,
): readonly SessionSummary[] {
  if (sorting === 'manual') {
    const position = new Map((manualOrder ?? []).map((id, index) => [id, index]))
    const sorted = [...sessions].sort(
      (left, right) =>
        (position.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    return pinCurrentBlank(sorted, activeSessionId)
  }
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

/**
 * The official workspace runtime promotes the current blank New Session row
 * to the head of the workspace order. Keep that visual invariant even when a
 * stale session-order projection still places another row first.
 */
function pinCurrentBlank(
  sessions: readonly SessionSummary[],
  activeSessionId: string | undefined,
): readonly SessionSummary[] {
  if (activeSessionId === undefined) return sessions
  const index = sessions.findIndex((session) => session.id === activeSessionId && session.blank)
  if (index <= 0) return sessions
  const active = sessions[index]
  if (active === undefined) return sessions
  return [active, ...sessions.slice(0, index), ...sessions.slice(index + 1)]
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

function sessionStatusTone(status: SessionSummary['status']): 'blue' | 'green' | 'amber' | 'red' | 'muted' {
  switch (status) {
    case 'running':
      return 'blue'
    case 'awaiting-input':
      return 'amber'
    case 'completed':
      return 'green'
    case 'failed':
      return 'red'
    case 'idle':
      return 'muted'
  }
}
