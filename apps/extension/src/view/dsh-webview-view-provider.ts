import * as vscode from 'vscode'

import { SIDEBAR_SURFACE_ID, VIEW_ID } from '../constants.js'
import { createWebviewHtml } from './webview-html.js'
import { WebviewSurfaceChannel, type WebviewSurface } from './webview-surface.js'

export interface DshWebviewDependencies {
  readonly extensionUri: vscode.Uri
  readonly onMessage: (message: unknown) => Promise<void>
  /** Observe a rejected Webview message task; event callbacks cannot await it. */
  readonly onMessageError?: (error: unknown) => void
  /** The validated ready handshake arrived; surface-directed events may be posted. */
  readonly onBecameReady?: () => void
  /** The user opened a visible view; begin connection while its assets load. */
  readonly onViewOpened?: () => void
  /**
   * A resolved Webview went away: re-resolved, hidden by the user, or the whole
   * provider disposed. Cancel this surface's in-flight work — but the surface
   * itself stays registered, because the view can come back.
   */
  readonly onViewDisposed?: () => void
  /** The surface is gone for good and must leave routing. */
  readonly onSurfaceClosed?: () => void
  /** Host-assigned identity; defaults to the sidebar surface. */
  readonly surfaceId?: string
  readonly onVisibilityChanged?: (visible: boolean) => void
}

/**
 * The secondary-side-bar chat surface. It is one of possibly several live
 * surfaces: re-resolving the view disposes only this surface's channel, and the
 * shared teardown (job follows, editor context) is decided by the registry.
 */
export class DshWebviewViewProvider implements vscode.WebviewViewProvider, WebviewSurface {
  public static readonly viewType = VIEW_ID
  public readonly kind = 'sidebar' as const
  public readonly surfaceId: string
  public readonly sessionId: string | undefined = undefined
  private view: vscode.WebviewView | undefined
  private channel: WebviewSurfaceChannel | undefined
  private readonly viewListeners: vscode.Disposable[] = []
  private readonly readyWaiters = new Set<(ready: boolean) => void>()
  private isVisible = false
  private disposed = false

  public constructor(private readonly dependencies: DshWebviewDependencies) {
    this.surfaceId = dependencies.surfaceId ?? SIDEBAR_SURFACE_ID
  }

  public get isReady(): boolean {
    return this.channel?.isReady ?? false
  }

  public get visible(): boolean {
    return this.isVisible
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    if (this.disposed) return
    if (this.view !== undefined) this.disposeViewListeners()
    this.view = webviewView
    this.isVisible = webviewView.visible
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.dependencies.extensionUri, 'media')],
    }
    webviewView.webview.html = createWebviewHtml(
      webviewView.webview,
      this.dependencies.extensionUri,
      vscode.env.language,
    )
    this.channel = new WebviewSurfaceChannel(webviewView.webview, {
      onMessage: this.dependencies.onMessage,
      ...(this.dependencies.onMessageError === undefined
        ? {}
        : { onMessageError: this.dependencies.onMessageError }),
      onBecameReady: () => {
        this.finishReadyWaiters(true)
        this.dependencies.onBecameReady?.()
      },
      // Fires for every resolved Webview that goes away: a re-resolved view and
      // a disposed provider both make this surface's in-flight work unanswerable.
      onDisposed: () => this.dependencies.onViewDisposed?.(),
      // A superseded view must not flip readiness or reach the router.
      isCurrent: () => this.view === webviewView,
    })
    this.viewListeners.push(
      webviewView.onDidDispose(() => {
        if (this.view !== webviewView) return
        this.view = undefined
        this.isVisible = false
        this.disposeViewListeners()
      }),
      webviewView.onDidChangeVisibility(() => {
        if (this.view !== webviewView) return
        this.isVisible = webviewView.visible
        if (this.isVisible) this.dependencies.onViewOpened?.()
        this.dependencies.onVisibilityChanged?.(this.isVisible && this.isReady)
      }),
    )
    if (this.isVisible) this.dependencies.onViewOpened?.()
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.disposed
      ? Promise.resolve(false)
      : (this.channel?.postMessage(message) ?? Promise.resolve(false))
  }

  /** Focusing can finish before VS Code resolves the view or loads its script. */
  public waitUntilReady(timeoutMs = 10_000): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.isReady) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (ready: boolean): void => {
        clearTimeout(timer)
        this.readyWaiters.delete(finish)
        resolve(ready)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.readyWaiters.add(finish)
    })
  }

  public reveal(preserveFocus = true): Promise<void> {
    this.view?.show(preserveFocus)
    return Promise.resolve()
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const hadChannel = this.channel !== undefined
    this.disposeViewListeners()
    this.view = undefined
    this.isVisible = false
    // A provider that never resolved a view has no channel to report the
    // cancellation, but the surface is still gone.
    if (!hadChannel) this.dependencies.onViewDisposed?.()
    this.dependencies.onSurfaceClosed?.()
  }

  private disposeViewListeners(): void {
    this.finishReadyWaiters(false)
    while (this.viewListeners.length > 0) this.viewListeners.pop()?.dispose()
    const channel = this.channel
    this.channel = undefined
    channel?.dispose()
  }

  private finishReadyWaiters(ready: boolean): void {
    for (const finish of [...this.readyWaiters]) finish(ready)
  }
}
