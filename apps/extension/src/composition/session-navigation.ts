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
  const invalidate = (): void => {
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
          observedKind = payload.kind
          observedBackend = backend
          for (const listener of listeners) listener('connection')
        }
        return
      }
      syncSessionTitles(name, payload, deps.retitleEditorTab)
      if (
        DIRECTORY_EVENTS.has(name) ||
        (name === 'session.projection' &&
          typeof payload === 'object' &&
          payload !== null &&
          'key' in payload &&
          (payload.key === 'title' || payload.key === 'sessionListMetadata'))
      )
        invalidate()
    },
  }
}

/** Use the upstream title view directly, including reconnect and follow baselines. */
function syncSessionTitles(
  name: string,
  payload: unknown,
  retitle: NavigationDependencies['retitleEditorTab'],
): void {
  if (retitle === undefined) return
  if (
    name !== 'session.title' &&
    name !== 'session.projection' &&
    name !== 'session.projection.baseline' &&
    name !== 'session.subscribed'
  )
    return
  const event = objectRecord(payload)
  if (event === undefined) return
  const apply = (sessionId: unknown, title: unknown): void => {
    if (typeof sessionId === 'string' && sessionId.trim() !== '' && typeof title === 'string')
      retitle(sessionId, title)
  }
  if (name === 'session.title') apply(event.sessionId, event.title)
  else if (name === 'session.projection' && event.key === 'title') apply(event.sessionId, event.value)
  else if (name === 'session.subscribed')
    apply(event.sessionId, objectRecord(objectRecord(event.projection)?.values)?.title)
  else if (name === 'session.projection.baseline') {
    for (const [sessionId, projection] of Object.entries(objectRecord(event.projections) ?? {}))
      apply(sessionId, objectRecord(objectRecord(projection)?.values)?.title)
  }
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
  'session.activity',
])
