import * as vscode from 'vscode'
import { AppError, type DshBackend } from '@dsh-vscode/domain'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import { webviewRequestSchema } from '@dsh-vscode/webview-protocol'
import { randomUUID } from 'node:crypto'
import type { RequestGatewayDependencies } from './request-gateway-dependencies.js'
import { listScopedSessions, type DirectoryDependencies } from './session-directory.js'
import { SIDEBAR_SURFACE_ID, VIEW_ID } from '../constants.js'
import type { DshWebviewViewProvider } from '../view/dsh-webview-view-provider.js'

export interface SessionDirectoryView {
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly sessions: readonly {
    readonly id: string
    readonly workspaceId: string
    readonly title: string
    readonly blank: boolean
  }[]
}

type NavigationDependencies = DirectoryDependencies &
  Pick<RequestGatewayDependencies, 'requireCurrentWorkspaceSession' | 'postEventTo' | 'postEvent'> & {
    readonly backendService: Pick<RequestGatewayDependencies['backendService'], 'requireBackend'>
    /** Keep an open editor tab's label in step with a session title change. */
    readonly retitleEditorTab?: (sessionId: string, title: string) => void
  }

export interface SessionNavigation {
  readonly activeSessionId: string | undefined
  readonly connected: boolean
  invalidate(this: void): void
  select(this: void, sessionId: string): void
  onDidChange(
    this: void,
    listener: (change: 'selection' | 'directory' | 'connection') => void,
  ): vscode.Disposable
  read(this: void, signal: AbortSignal): Promise<SessionDirectoryView>
  open(this: void, sessionId: string, editor: boolean, signal: AbortSignal): Promise<void>
  rename(this: void, sessionId: string, title: string, signal: AbortSignal): Promise<void>
  archive(this: void, sessionId: string, signal: AbortSignal): Promise<void>
  acceptEvent(this: void, name: string, payload?: unknown): void
}

/** Navigation over the existing Host routes; never owns history or another DSH stream. */
export function createSessionNavigation(
  deps: NavigationDependencies,
  provider: Pick<DshWebviewViewProvider, 'waitUntilReady'>,
  request: (request: WebviewRequest, signal: AbortSignal) => Promise<unknown>,
  openInEditor: (id: string, column: vscode.ViewColumn | undefined, signal: AbortSignal) => Promise<void>,
): SessionNavigation {
  const listeners = new Set<(change: 'selection' | 'directory' | 'connection') => void>()
  let activeSessionId: string | undefined
  let observedKind: unknown
  let observedBackend: DshBackend | undefined
  let activityRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let activityDirty = false
  const clearActivityRefresh = (): void => {
    if (activityRefreshTimer !== undefined) clearTimeout(activityRefreshTimer)
    activityRefreshTimer = undefined
    activityDirty = false
  }
  /** Last title applied per session, so same-value re-emissions are no-ops. */
  const titleState = new Map<string, string>()
  /** Highest title sequence applied per session; stale re-emissions lose. */
  const titleSequence = new Map<string, number>()
  let directoryBaseline: string | undefined
  const invalidate = (): void => {
    // Any full re-read supersedes a pending activity-only refresh.
    clearActivityRefresh()
    for (const listener of listeners) listener('directory')
  }
  const connected = (): boolean => {
    if (observedKind !== undefined && observedKind !== 'connected') return false
    try {
      const backend = deps.backendService.requireBackend()
      return observedKind === undefined || (observedBackend !== undefined && observedBackend === backend)
    } catch {
      return false
    }
  }
  const requireConnected = (): void => {
    if (!vscode.workspace.isTrusted)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Trust this workspace to open sessions.',
        retryable: false,
      })
    if (!connected())
      throw new AppError({ code: 'BACKEND_UNREACHABLE', message: 'Connect to DSH first.', retryable: true })
  }
  return {
    invalidate,
    get connected(): boolean {
      return connected()
    },
    get activeSessionId(): string | undefined {
      return activeSessionId
    },
    select: (sessionId: string): void => {
      if (activeSessionId === sessionId) return
      activeSessionId = sessionId
      for (const listener of listeners) listener('selection')
    },
    onDidChange: (
      listener: (change: 'selection' | 'directory' | 'connection') => void,
    ): vscode.Disposable => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
          if (listeners.size === 0) clearActivityRefresh()
        },
      }
    },
    read: async (signal: AbortSignal): Promise<SessionDirectoryView> => {
      signal.throwIfAborted()
      requireConnected()
      const workspaces = await deps.listCurrentWorkspaces(signal)
      const page = await listScopedSessions(deps, {}, signal, workspaces)
      return {
        workspaces: workspaces.map(({ id, name }) => ({ id, name })),
        sessions: page.items
          .filter(({ origin }) => origin !== 'subagent')
          .map(({ id, workspaceId, title, blank }) => ({ id, workspaceId, title, blank })),
      }
    },
    open: async (sessionId: string, editor: boolean, signal: AbortSignal): Promise<void> => {
      if (editor) return openInEditor(sessionId, undefined, signal)
      requireConnected()
      await deps.requireCurrentWorkspaceSession(sessionId, signal)
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`)
      if (!(await provider.waitUntilReady())) throw new Error('The chat view is not ready.')
      signal.throwIfAborted()
      if (!(await deps.postEventTo(SIDEBAR_SURFACE_ID, 'ui.surface.openInSidebar', { sessionId })))
        throw new Error('The chat could not be opened.')
    },
    rename: async (sessionId: string, title: string, signal: AbortSignal): Promise<void> => {
      await request(
        webviewRequestSchema.parse({
          requestId: randomUUID(),
          type: 'session.rename',
          payload: { sessionId, title },
        }),
        signal,
      )
    },
    archive: async (sessionId: string, signal: AbortSignal): Promise<void> => {
      await request(
        webviewRequestSchema.parse({
          requestId: randomUUID(),
          type: 'session.archive',
          payload: { sessionId, archived: true },
        }),
        signal,
      )
      // Re-read authoritative archive state in every Webview, without clearing
      // captured editor context as a workspace-change notification would do.
      try {
        const workspaces = await deps.listCurrentWorkspaces(signal)
        const sessionIds = await deps.listCurrentArchivedSessionIds(workspaces, signal)
        await deps.postEvent('archived.sessions.changed', { sessionIds })
      } catch {
        signal.throwIfAborted()
        throw new AppError({
          code: 'BACKEND_UNREACHABLE',
          message:
            'The session was archived, but its list could not be refreshed. Refresh sessions to retry.',
          retryable: true,
        })
      }
    },
    acceptEvent: (name: string, payload?: unknown): void => {
      if (name === 'connection.lost') {
        observedKind = 'disconnected'
        observedBackend = undefined
        // A reconnect re-baselines through snapshots; allow them to seed again,
        // and the durable sequence space may reset on a restarted host.
        titleSequence.clear()
        directoryBaseline = undefined
        for (const listener of listeners) listener('connection')
        return
      }
      if (
        name === 'connection.snapshot' &&
        typeof payload === 'object' &&
        payload !== null &&
        'kind' in payload
      ) {
        let backend: DshBackend | undefined
        if (payload.kind === 'connected') {
          try {
            backend = deps.backendService.requireBackend()
          } catch {
            /* Attach has not completed yet. */
          }
        }
        if (observedKind !== payload.kind || observedBackend !== backend) {
          if (observedBackend !== backend) {
            titleSequence.clear()
            titleState.clear()
            directoryBaseline = undefined
          }
          observedKind = payload.kind
          observedBackend = backend
          for (const listener of listeners) listener('connection')
        }
        return
      }
      const titleChanged = syncSessionTitles(name, payload, deps.retitleEditorTab, titleState, titleSequence)
      const projectionKey = objectRecord(payload)?.key
      if (name === 'session.projection.baseline') {
        const signature = JSON.stringify(
          Object.entries(objectRecord(objectRecord(payload)?.projections) ?? {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, projection]) => [
              id,
              objectRecord(objectRecord(projection)?.values)?.sessionListMetadata,
            ]),
        )
        const changed = signature !== directoryBaseline
        directoryBaseline = signature
        if (titleChanged || changed) invalidate()
        return
      }
      if (name === 'session.activity') {
        if (listeners.size === 0) return
        // Streaming emits an activity event per step, and a directory read is
        // two backend RPCs. Coalesce a burst behind a trailing window so the
        // tree's ordering stays eventual within a second instead of chaining
        // back-to-back full re-reads for the whole stream.
        activityDirty = true
        if (activityRefreshTimer === undefined)
          activityRefreshTimer = setTimeout(() => {
            activityRefreshTimer = undefined
            if (!activityDirty) return
            activityDirty = false
            invalidate()
          }, ACTIVITY_REFRESH_MS)
        return
      }
      // Title-carrying events only refresh the directory when the title actually
      // changed; a re-emitted baseline or a same-value title projection must not
      // re-read the whole session list (this was the UI-jitter amplification).
      if (
        name === 'session.title' ||
        name === 'session.subscribed' ||
        (name === 'session.projection' && projectionKey === 'title')
      ) {
        if (titleChanged) invalidate()
        return
      }
      if (
        DIRECTORY_EVENTS.has(name) ||
        (name === 'session.projection' && projectionKey === 'sessionListMetadata')
      )
        invalidate()
    },
  }
}

/**
 * Use the upstream title view directly, including reconnect and follow baselines.
 * Live events and snapshot baselines are latest-wins by durable sequence, so a re-baseline that replays
 * an older fallback title after a newer provider title does not flip the tab.
 * Returns whether any title actually changed, so the caller can skip a directory
 * refresh for same-value re-emissions.
 */
function syncSessionTitles(
  name: string,
  payload: unknown,
  retitle: NavigationDependencies['retitleEditorTab'],
  titleState: Map<string, string>,
  titleSequence: Map<string, number>,
): boolean {
  if (
    name !== 'session.title' &&
    name !== 'session.projection' &&
    name !== 'session.projection.baseline' &&
    name !== 'session.subscribed'
  )
    return false
  const event = objectRecord(payload)
  if (event === undefined) return false
  let changed = false
  const applyLive = (sessionId: unknown, title: unknown, sequence: number | undefined): void => {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || typeof title !== 'string') return
    if (!applyNewerTitle(sessionId, sequence, titleSequence)) return
    if (titleState.get(sessionId) !== title) {
      titleState.set(sessionId, title)
      retitle?.(sessionId, title)
      changed = true
    }
  }
  const applySeed = (sessionId: unknown, title: unknown, sequence: number | undefined): void => {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || typeof title !== 'string') return
    // An unsequenced snapshot cannot supersede known sequenced state.
    if (sequence === undefined && titleSequence.has(sessionId)) return
    if (!applyNewerTitle(sessionId, sequence, titleSequence)) return
    if (titleState.get(sessionId) !== title) {
      titleState.set(sessionId, title)
      retitle?.(sessionId, title)
      changed = true
    }
  }
  if (name === 'session.title') applyLive(event.sessionId, event.title, safeSequence(event.sequence))
  else if (name === 'session.projection' && event.key === 'title')
    applyLive(event.sessionId, event.value, safeSequence(event.sequence))
  else if (name === 'session.subscribed')
    applySeed(
      event.sessionId,
      objectRecord(objectRecord(event.projection)?.values)?.title,
      safeSequence(objectRecord(event.projection)?.asOfSequence),
    )
  else if (name === 'session.projection.baseline') {
    for (const [sessionId, projection] of Object.entries(objectRecord(event.projections) ?? {}))
      applySeed(
        sessionId,
        objectRecord(objectRecord(projection)?.values)?.title,
        safeSequence(objectRecord(projection)?.asOfSequence),
      )
  }
  return changed
}

/**
 * Accept a title only when its durable sequence is at least as recent as the
 * last one applied. Unsequenced titles (older wires / host notices) skip the
 * sequence guard and rely on the value dedupe above.
 */
function applyNewerTitle(
  sessionId: string,
  sequence: number | undefined,
  titleSequence: Map<string, number>,
): boolean {
  if (sequence === undefined) return true
  const previous = titleSequence.get(sessionId)
  if (previous !== undefined && sequence < previous) return false
  titleSequence.set(sessionId, sequence)
  return true
}

function safeSequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

const DIRECTORY_EVENTS = new Set([
  'ui.resync',
  'session.projection.baseline',
  'workspace.changed',
  'workspace.removed',
  'workspace.order.changed',
  'archived.sessions.changed',
  'session.added',
  'session.removed',
  'session.title',
])

/** Streaming emits activity events per step; see the trailing window in acceptEvent. */
const ACTIVITY_REFRESH_MS = 1_000
