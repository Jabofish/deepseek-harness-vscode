import type * as vscode from 'vscode'
import { webviewEnvelopeSchema } from '@dsh-vscode/webview-protocol'

/**
 * Where a live chat Webview is hosted. The secondary-side-bar view is the
 * `sidebar` surface; every editor-area panel is an `editor` surface bound to
 * one session. Surface identity is Host-owned: it is assigned here and told to
 * the Webview through `ui.surface.assigned`, never chosen by the client.
 */
export type WebviewSurfaceKind = 'sidebar' | 'editor'

/**
 * One live Webview that speaks the DSH protocol. Callers must not assume there
 * is exactly one: responses and cancellations are routed back through the
 * surface that asked, and only the registry knows which surfaces exist.
 */
export interface WebviewSurface extends vscode.Disposable {
  readonly surfaceId: string
  readonly kind: WebviewSurfaceKind
  /** The session an editor surface is bound to; undefined for the sidebar. */
  readonly sessionId: string | undefined
  readonly visible: boolean
  readonly isReady: boolean
  postMessage(message: unknown): Thenable<boolean>
  waitUntilReady(timeoutMs?: number): Promise<boolean>
  reveal(preserveFocus?: boolean): Promise<void>
}

export interface WebviewSurfaceChannelDependencies {
  readonly onMessage: (message: unknown) => Promise<void>
  readonly onMessageError?: (error: unknown) => void
  /** The validated `app.ready` handshake arrived; the surface may be posted to. */
  readonly onBecameReady?: () => void
  /** Listeners are gone: a superseded view or a disposed panel. */
  readonly onDisposed?: () => void
  /** Messages from a superseded Webview must not flip readiness or reach the router. */
  readonly isCurrent?: () => boolean
}

/**
 * The message listener, ready handshake, and waiters shared by both surfaces.
 * A surface may be re-resolved (the view after being hidden) or disposed (the
 * panel closed by the user); this channel owns the per-Webview part of that
 * lifecycle so the surface classes only describe how they are shown.
 */
export class WebviewSurfaceChannel implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly waiters = new Set<(ready: boolean) => void>()
  private ready = false
  private disposed = false

  public constructor(
    private readonly webview: vscode.Webview,
    private readonly dependencies: WebviewSurfaceChannelDependencies,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((message: unknown) => {
        // VS Code does not await message listeners. Assimilate both a
        // synchronous throw and a rejected task so a failed response cannot
        // become an unhandled Promise rejection.
        void Promise.resolve()
          .then(() => {
            if (this.disposed) return
            if (this.dependencies.isCurrent !== undefined && !this.dependencies.isCurrent()) return
            const parsed = webviewEnvelopeSchema.safeParse(message)
            if (parsed.success && parsed.data.message.type === 'app.ready') this.markReady()
            return this.dependencies.onMessage(message)
          })
          .catch((error: unknown) => {
            try {
              this.dependencies.onMessageError?.(error)
            } catch {
              // Error reporting must not escape the VS Code event callback.
            }
          })
      }),
    )
  }

  public get isReady(): boolean {
    return this.ready
  }

  public postMessage(message: unknown): Thenable<boolean> {
    return this.ready ? this.webview.postMessage(message) : Promise.resolve(false)
  }

  /** A resolved surface may still be loading its client script. */
  public waitUntilReady(timeoutMs = 10_000): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const finish = (ready: boolean): void => {
        clearTimeout(timer)
        this.waiters.delete(finish)
        resolve(ready)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.waiters.add(finish)
    })
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    this.finishWaiters(false)
    while (this.disposables.length > 0) this.disposables.pop()?.dispose()
    this.dependencies.onDisposed?.()
  }

  private markReady(): void {
    if (this.ready) return
    this.ready = true
    this.finishWaiters(true)
    this.dependencies.onBecameReady?.()
  }

  private finishWaiters(ready: boolean): void {
    for (const finish of [...this.waiters]) finish(ready)
  }
}
