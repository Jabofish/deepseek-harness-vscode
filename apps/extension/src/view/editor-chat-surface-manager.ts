import * as vscode from 'vscode'
import {
  DshWebviewPanelSurface,
  type DshWebviewPanelSurfaceDependencies,
} from './dsh-webview-panel-surface.js'
import type { WebviewSurfaceRegistry } from './webview-surface-registry.js'

export interface EditorChatSurfaceManagerDependencies {
  /** Every editor tab must be routable: a response goes back to its surface. */
  readonly surfaces: WebviewSurfaceRegistry
  readonly extensionUri: vscode.Uri
  /** Route a message to the surface that sent it. */
  readonly onMessage: (surfaceId: string, message: unknown) => Promise<void>
  readonly onMessageError: (error: unknown) => void
  readonly onBecameReady: (surface: DshWebviewPanelSurface) => void
  readonly onDisposed: (surface: DshWebviewPanelSurface) => void
  readonly onVisibilityChanged?: (surface: DshWebviewPanelSurface) => void
  /** Fired after every create/restore/dispose with the new editor-surface count. */
  readonly onCountChanged: (count: number) => void
}

const DEFAULT_EDITOR_CHAT_TITLE = 'JaboDSH'

/**
 * The session an editor chat was showing before a window reload. A panel
 * restored by `registerWebviewPanelSerializer` is handed the Webview's own
 * persisted state; the store writes `activeSessionId` there, and nothing else
 * in that blob is trusted.
 */
export function persistedEditorChatSessionId(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return undefined
  const value = (state as { readonly activeSessionId?: unknown }).activeSessionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The editor-area chat surfaces: at most one per session, keyed by the session
 * it shows. Opening an already-open session reveals its tab instead of creating
 * a second one, and closing a tab (by the user or by `close`) removes exactly
 * that surface.
 */
export class EditorChatSurfaceManager implements vscode.Disposable {
  private readonly surfaces = new Map<string, DshWebviewPanelSurface>()
  private readonly surfaceIdBySession = new Map<string, string>()
  private nextUnboundId = 1
  private disposed = false

  public constructor(private readonly dependencies: EditorChatSurfaceManagerDependencies) {}

  public get count(): number {
    return this.surfaces.size
  }

  public get surfacesById(): readonly DshWebviewPanelSurface[] {
    return [...this.surfaces.values()]
  }

  public forSession(sessionId: string): DshWebviewPanelSurface | undefined {
    const surfaceId = this.surfaceIdBySession.get(sessionId)
    return surfaceId === undefined ? undefined : this.surfaces.get(surfaceId)
  }

  /** A newly created session replaces the draft in the originating editor. */
  public bind(surfaceId: string, sessionId: string, title?: string): void {
    this.requireActive()
    const surface = this.surfaces.get(surfaceId)
    if (surface === undefined) throw new Error('The originating editor chat is closed.')
    const existing = this.forSession(sessionId)
    if (existing !== undefined && existing !== surface)
      throw new Error('This session already has an editor chat.')
    if (surface.sessionId !== undefined) this.surfaceIdBySession.delete(surface.sessionId)
    surface.sessionId = sessionId
    this.surfaceIdBySession.set(sessionId, surfaceId)
    surface.setTitle(title ?? DEFAULT_EDITOR_CHAT_TITLE)
  }

  /** Create the session's editor tab, or reveal the existing one. */
  public open(sessionId: string, title?: string, column?: vscode.ViewColumn): DshWebviewPanelSurface {
    this.requireActive()
    const existing = this.forSession(sessionId)
    if (existing !== undefined) {
      if (column === undefined) void existing.reveal(false)
      else existing.panel.reveal(column, false)
      return existing
    }
    const surfaceId = this.surfaceIdForSession(sessionId)
    this.surfaceIdBySession.set(sessionId, surfaceId)
    return this.create(surfaceId, sessionId, title ?? DEFAULT_EDITOR_CHAT_TITLE, column)
  }

  /**
   * Adopt a panel restored by `registerWebviewPanelSerializer` after a window
   * reload. The session comes from the Webview's own persisted state; without
   * one the surface boots unbound and performs its normal startup restore.
   */
  public adopt(panel: vscode.WebviewPanel, sessionId: string | undefined): DshWebviewPanelSurface {
    this.requireActive()
    if (sessionId !== undefined) this.forSession(sessionId)?.dispose()
    const surfaceId =
      sessionId === undefined ? `editor:unbound:${this.nextUnboundId++}` : this.surfaceIdForSession(sessionId)
    // One tab per session is an invariant, not a preference: a restored panel
    // for a session that already has a live tab replaces it, and the replaced
    // tab is closed rather than dropped from the routes.
    this.surfaces.get(surfaceId)?.dispose()
    if (sessionId !== undefined) this.surfaceIdBySession.set(sessionId, surfaceId)
    const surface = new DshWebviewPanelSurface(panel, this.surfaceDependencies(surfaceId, sessionId))
    this.track(surfaceId, surface)
    return surface
  }

  /** Keep an open editor tab's label in step with a renamed session. */
  public retitle(sessionId: string, title: string): void {
    this.forSession(sessionId)?.setTitle(title)
  }

  public close(surfaceId: string): void {
    this.surfaces.get(surfaceId)?.dispose()
  }

  public closeAll(): void {
    for (const surface of [...this.surfaces.values()]) surface.dispose()
  }

  /** The most recently registered editor tab, if any. */
  public get mostRecent(): DshWebviewPanelSurface | undefined {
    return [...this.surfaces.values()].at(-1)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closeAll()
  }

  private create(
    surfaceId: string,
    sessionId: string | undefined,
    title: string,
    column?: vscode.ViewColumn,
  ): DshWebviewPanelSurface {
    const surface = DshWebviewPanelSurface.create({
      ...this.surfaceDependencies(surfaceId, sessionId),
      title,
      viewColumn: column ?? vscode.ViewColumn.Active,
      preserveFocus: false,
    })
    this.track(surfaceId, surface)
    return surface
  }

  private surfaceDependencies(
    surfaceId: string,
    sessionId: string | undefined,
  ): DshWebviewPanelSurfaceDependencies {
    return {
      surfaceId,
      sessionId,
      extensionUri: this.dependencies.extensionUri,
      onMessage: (message) => this.dependencies.onMessage(surfaceId, message),
      onMessageError: this.dependencies.onMessageError,
      onBecameReady: this.dependencies.onBecameReady,
      ...(this.dependencies.onVisibilityChanged === undefined
        ? {}
        : { onVisibilityChanged: this.dependencies.onVisibilityChanged }),
      onDisposed: (surface) => {
        this.forget(surface)
        this.dependencies.onDisposed(surface)
      },
    }
  }

  private track(surfaceId: string, surface: DshWebviewPanelSurface): void {
    this.surfaces.set(surfaceId, surface)
    this.dependencies.surfaces.register(surface)
    this.dependencies.onCountChanged(this.surfaces.size)
  }

  private forget(surface: DshWebviewPanelSurface): void {
    if (this.surfaces.get(surface.surfaceId) === surface) this.surfaces.delete(surface.surfaceId)
    this.dependencies.surfaces.unregister(surface.surfaceId)
    const boundSession = surface.sessionId
    if (boundSession !== undefined && this.surfaceIdBySession.get(boundSession) === surface.surfaceId)
      this.surfaceIdBySession.delete(boundSession)
    this.dependencies.onCountChanged(this.surfaces.size)
  }

  private surfaceIdForSession(sessionId: string): string {
    const base = `editor:${sessionId}`
    return this.surfaces.has(base) ? `${base}:${this.nextUnboundId++}` : base
  }

  private requireActive(): void {
    if (this.disposed) throw new Error('The editor chat manager is closed.')
  }
}
