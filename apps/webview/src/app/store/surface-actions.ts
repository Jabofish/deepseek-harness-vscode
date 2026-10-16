import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { isMovetoCommandLine, movetoTargetOf, type MovetoOutcome } from '../client-commands.js'
import type { ProtocolClient } from '../protocol-client.js'
import { isSurfaceEventName } from './event-parser.js'
import { nonEmptyString } from './event-values.js'
import { requestId } from './ids.js'
import type { AppActions, AppState, StateSetter, SurfaceAssignment } from './types.js'
import { object } from './unknown-record.js'

/** Editor tab titles are bounded by the protocol schema; the Host re-sanitizes. */
const MAX_EDITOR_TITLE_CHARS = 120

export interface SurfaceActionHost {
  readonly client: ProtocolClient
  readonly getState: () => AppState
  readonly setState: StateSetter
  /**
   * The store's ordinary session-open path. A bound editor tab uses exactly the
   * same open as the session list; the surface never reimplements it.
   */
  readonly openSession: (sessionId: string) => Promise<void>
}

/**
 * True while the side bar is handed off to one or more editor tabs. In that
 * posture the side bar renders a card instead of a conversation, so opening a
 * session there would switch an invisible chat: the user gesture must create
 * (or reveal) an editor tab instead.
 */
export function isHandoffSidebar(state: {
  readonly surface?: SurfaceAssignment | undefined
  readonly editorChats: number
}): boolean {
  return (state.surface?.kind ?? 'sidebar') === 'sidebar' && state.editorChats > 0
}

export interface SurfaceActions {
  readonly methods: Pick<AppActions, 'moveChatToSidebar' | 'openSessionInEditor' | 'runMovetoCommand'>
  /**
   * Apply one Host surface-control frame. Returns false for every other
   * message so the subscription keeps reducing ordinary host traffic.
   */
  readonly applySurfaceEvent: (message: HostMessage) => boolean
}

/**
 * Surface control frames are UI-only: they never become conversation rows.
 * The parser owns the allowlist; `applySurfaceEvent` uses the same predicate so
 * the two decisions cannot drift.
 */
export function createSurfaceActions(host: SurfaceActionHost): SurfaceActions {
  const { client, getState, setState, openSession } = host

  /**
   * `ui.surface.assigned` is posted before the Host answers `app.ready`, so the
   * assignment can already be in state while `initialize()` is still waiting on
   * its readiness reply. Both that ordering and the reverse are safe: the
   * assignment opens the bound session here, and the startup restore refuses to
   * run on an editor surface.
   */
  const applyAssigned = (payload: unknown): void => {
    const assigned = object(payload)
    const kind = assigned?.kind === 'editor' ? 'editor' : assigned?.kind === 'sidebar' ? 'sidebar' : undefined
    if (kind === undefined) return
    // A bound session id is only meaningful for an editor tab; a side bar
    // assignment never carries one and always means "no binding".
    const rawSessionId = kind === 'editor' ? assigned?.sessionId : undefined
    const sessionId = nonEmptyString(rawSessionId) ? rawSessionId : undefined
    const surface: SurfaceAssignment = sessionId === undefined ? { kind } : { kind, sessionId }
    setState((current) => {
      if (current.surface?.kind === surface.kind && current.surface.sessionId === surface.sessionId)
        return current
      return { ...current, surface }
    })
    if (kind !== 'editor' || sessionId === undefined) return
    // A reveal or a reload re-assigns the same tab. Only a bound session that
    // is not on screen yet has anything to load; re-opening the active one would
    // discard the transcript and replay its history.
    if (getState().activeSessionId === sessionId) return
    void openSession(sessionId).catch(() => undefined)
  }

  const applyHandoff = (payload: unknown): void => {
    const editorChats = object(payload)?.editorChats
    if (typeof editorChats !== 'number' || !Number.isSafeInteger(editorChats) || editorChats < 0) return
    setState((current) => (current.editorChats === editorChats ? current : { ...current, editorChats }))
  }

  /**
   * The Command Palette asks the live side bar to hand its session to a new
   * editor tab. An editor surface already shows this conversation and must not
   * open a second tab for itself, and the Host owns the user-facing warning
   * when nothing is selected.
   */
  const requestEditorTab = (sessionId: string): void => {
    const title = editorTabTitle(getState(), sessionId)
    void client
      .request<unknown>({
        type: 'surface.openInEditor',
        requestId: requestId(),
        payload: { sessionId, ...(title === undefined ? {} : { title }) },
      })
      .catch(() => undefined)
  }

  const requestOpenInEditor = (): void => {
    const state = getState()
    if (state.surface?.kind === 'editor') return
    const sessionId = state.activeSessionId
    if (sessionId === undefined) return
    requestEditorTab(sessionId)
  }

  /** A session picked while the side bar is handed off becomes an editor tab. */
  const openSessionInEditor = (sessionId: string): void => requestEditorTab(sessionId)

  /**
   * The client-owned `/moveto` command. A malformed target or a missing session
   * is reported instead of being spelled as a prompt, and the line is never
   * forwarded to DSH.
   */
  const runMovetoCommand = async (line: string): Promise<MovetoOutcome> => {
    const target = isMovetoCommandLine(line) ? movetoTargetOf(line) : undefined
    if (target === undefined) return 'unknown-target'
    if (target === 'sidebar') {
      await moveChatToSidebar()
      return 'sidebar'
    }
    const current = getState()
    // An editor surface already shows its own session in the editor area.
    if (current.surface?.kind === 'editor') return 'editor'
    const sessionId = current.activeSessionId
    if (sessionId === undefined) return 'no-session'
    requestEditorTab(sessionId)
    return 'editor'
  }

  const applySurfaceEvent = (message: HostMessage): boolean => {
    if (message.type !== 'event' || !isSurfaceEventName(message.name)) return false
    if (message.name === 'ui.surface.assigned') applyAssigned(message.payload)
    else if (message.name === 'ui.surface.handoff') applyHandoff(message.payload)
    else requestOpenInEditor()
    return true
  }

  const moveChatToSidebar = (): Promise<void> =>
    client.request<unknown>({ type: 'surface.moveToSidebar', requestId: requestId() }).then(() => undefined)

  return {
    methods: { moveChatToSidebar, openSessionInEditor, runMovetoCommand },
    applySurfaceEvent,
  }
}

/** The session title the tab can show; the Host treats it as a label only. */
function editorTabTitle(state: AppState, sessionId: string): string | undefined {
  const title = state.sessions.find((session) => session.id === sessionId)?.title.trim()
  if (title === undefined || title === '') return undefined
  return title.slice(0, MAX_EDITOR_TITLE_CHARS)
}
