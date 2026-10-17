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
  }

export interface SessionNavigation {
  readonly activeSessionId: string | undefined
  invalidate(this: void): void
  select(this: void, sessionId: string): void
  onDidChange(this: void, listener: (change: 'selection' | 'directory') => void): vscode.Disposable
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
  const listeners = new Set<(change: 'selection' | 'directory') => void>()
  let activeSessionId: string | undefined
  let observedKind: unknown
  let observedBackend: DshBackend | undefined
  const invalidate = (): void => {
    for (const listener of listeners) listener('directory')
  }
  const requireConnected = (): void => {
    if (!vscode.workspace.isTrusted)
      throw new AppError({
        code: 'PERMISSION_DENIED',
        message: 'Trust this workspace to open sessions.',
        retryable: false,
      })
    deps.backendService.requireBackend()
  }
  return {
    invalidate,
    get activeSessionId(): string | undefined {
      return activeSessionId
    },
    select: (sessionId: string): void => {
      if (activeSessionId === sessionId) return
      activeSessionId = sessionId
      for (const listener of listeners) listener('selection')
    },
    onDidChange: (listener: (change: 'selection' | 'directory') => void): vscode.Disposable => {
      listeners.add(listener)
      return {
        dispose: () => {
          listeners.delete(listener)
        },
      }
    },
    read: async (signal: AbortSignal): Promise<SessionDirectoryView> => {
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
          invalidate()
        }
        return
      }
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

const DIRECTORY_EVENTS = new Set([
  'connection.lost',
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
