import * as vscode from 'vscode'
import { EDITOR_CHAT_VIEW_TYPE } from '../constants.js'
import { createWebviewHtml } from './webview-html.js'
import { WebviewSurfaceChannel, type WebviewSurface } from './webview-surface.js'

export interface DshWebviewPanelSurfaceDependencies {
  /** Host-assigned identity; the Webview cannot choose or change it. */
  readonly surfaceId: string
  /** The session this editor chat is bound to, when it is known. */
  readonly sessionId: string | undefined
  readonly extensionUri: vscode.Uri
  readonly onMessage: (message: unknown) => Promise<void>
  readonly onMessageError?: (error: unknown) => void
  readonly onBecameReady?: (surface: DshWebviewPanelSurface) => void
  readonly onDisposed?: (surface: DshWebviewPanelSurface) => void
  readonly onVisibilityChanged?: (surface: DshWebviewPanelSurface) => void
}

export interface CreateDshWebviewPanelSurfaceOptions extends DshWebviewPanelSurfaceDependencies {
  readonly title: string
  readonly viewColumn?: vscode.ViewColumn
  readonly preserveFocus?: boolean
}

/**
 * An editor-area chat surface. One `WebviewPanel` shows exactly one session;
 * `retainContextWhenHidden` keeps the React tree and scroll position alive
 * while the user works in another tab, and the panel is restored after a window
 * reload through `registerWebviewPanelSerializer` (see the editor surface
 * manager, which adopts the restored panel).
 */
export class DshWebviewPanelSurface implements WebviewSurface {
  public static readonly viewType = EDITOR_CHAT_VIEW_TYPE
  public readonly kind = 'editor' as const
  public readonly surfaceId: string
  public sessionId: string | undefined
  private readonly listeners: vscode.Disposable[]
  private readonly channel: WebviewSurfaceChannel
  private isVisible: boolean
  private disposed = false

  public static create(options: CreateDshWebviewPanelSurfaceOptions): DshWebviewPanelSurface {
    const panel = vscode.window.createWebviewPanel(
      DshWebviewPanelSurface.viewType,
      options.title,
      {
        viewColumn: options.viewColumn ?? vscode.ViewColumn.Active,
        preserveFocus: options.preserveFocus ?? false,
      },
      { retainContextWhenHidden: true, enableFindWidget: true },
    )
    return new DshWebviewPanelSurface(panel, options)
  }

  public constructor(
    public readonly panel: vscode.WebviewPanel,
    private readonly dependencies: DshWebviewPanelSurfaceDependencies,
  ) {
    this.surfaceId = dependencies.surfaceId
    this.sessionId = dependencies.sessionId
    this.isVisible = panel.visible
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(dependencies.extensionUri, 'media')],
    }
    panel.webview.html = createWebviewHtml(panel.webview, dependencies.extensionUri, vscode.env.language)
    this.channel = new WebviewSurfaceChannel(panel.webview, {
      onMessage: dependencies.onMessage,
      ...(dependencies.onMessageError === undefined ? {} : { onMessageError: dependencies.onMessageError }),
      onBecameReady: () => dependencies.onBecameReady?.(this),
      // The channel is the per-Webview part of the lifecycle. Whether the panel
      // was disposed by the user or by `dispose()`, this is the single cleanup
      // path, so `onDisposed` fires exactly once.
      onDisposed: () => this.finishDispose(),
    })
    this.listeners = [
      panel.onDidDispose(() => this.finishDispose()),
      panel.onDidChangeViewState(() => {
        this.isVisible = panel.visible
        this.dependencies.onVisibilityChanged?.(this)
      }),
    ]
  }

  public get visible(): boolean {
    return this.isVisible && !this.disposed
  }

  public get isReady(): boolean {
    return this.channel.isReady
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.disposed ? Promise.resolve(false) : this.channel.postMessage(message)
  }

  public waitUntilReady(timeoutMs?: number): Promise<boolean> {
    return this.disposed ? Promise.resolve(false) : this.channel.waitUntilReady(timeoutMs)
  }

  public reveal(preserveFocus = true): Promise<void> {
    if (!this.disposed) this.panel.reveal(undefined, preserveFocus)
    return Promise.resolve()
  }

  /** Retitle the editor tab (the session name may change while it is open). */
  public setTitle(title: string): void {
    if (this.disposed) return
    const previous = this.panel.title
    // Same-value title writes still cost a Workbench tab re-render; skip them.
    if (previous === title) return
    this.panel.title = title
  }

  /** Close the editor tab; the user can do the same with the tab's ✕. */
  public dispose(): void {
    if (this.disposed) return
    // Disposing the channel runs `finishDispose` (which flips `disposed`), so
    // the panel reference is taken first and closed exactly once.
    const panel = this.panel
    this.channel.dispose()
    panel.dispose()
  }

  private finishDispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.isVisible = false
    this.channel.dispose()
    while (this.listeners.length > 0) this.listeners.pop()?.dispose()
    this.dependencies.onDisposed?.(this)
  }
}
