import type * as vscode from 'vscode'
import type { WebviewSurface } from './webview-surface.js'

/**
 * Every live chat Webview. The Host owns exactly one sidebar surface and zero
 * or more editor surfaces; `post` broadcasts while `postTo` targets the surface
 * that owns a request, so a response can never settle the wrong Webview.
 */
export class WebviewSurfaceRegistry implements vscode.Disposable {
  private readonly surfaces = new Map<string, WebviewSurface>()

  public register(surface: WebviewSurface): void {
    this.surfaces.set(surface.surfaceId, surface)
  }

  /** Remove a surface from routing without disposing it (its owner does that). */
  public unregister(surfaceId: string): void {
    this.surfaces.delete(surfaceId)
  }

  public get(surfaceId: string): WebviewSurface | undefined {
    return this.surfaces.get(surfaceId)
  }

  public list(): readonly WebviewSurface[] {
    return [...this.surfaces.values()]
  }

  /**
   * The surface a user-initiated action should target: the most recently
   * registered visible one, falling back to the most recently registered.
   */
  public get active(): WebviewSurface | undefined {
    const all = [...this.surfaces.values()]
    return all.filter((surface) => surface.visible).at(-1) ?? all.at(-1)
  }

  public get editorCount(): number {
    let count = 0
    for (const surface of this.surfaces.values()) if (surface.kind === 'editor') count += 1
    return count
  }

  public isEmpty(): boolean {
    return this.surfaces.size === 0
  }

  /** Broadcast: used for events that every surface filters for itself. */
  public async post(message: unknown, onMissedSurface?: (surfaceId: string) => void): Promise<boolean> {
    const targets = [...this.surfaces.values()]
    if (targets.length === 0) return false
    const results = await Promise.all(
      targets.map((surface) =>
        Promise.resolve()
          .then(() => surface.postMessage(message))
          .then(
            (delivered) => delivered,
            () => false,
          ),
      ),
    )
    const delivered = results.some(Boolean)
    // A successful editor post says nothing about delivery to the sidebar.
    // Unready/disposed surfaces recover through their own ready handshake.
    if (delivered && onMissedSurface !== undefined)
      for (const [index, surface] of targets.entries())
        if (!results[index] && surface.isReady && this.surfaces.get(surface.surfaceId) === surface)
          onMissedSurface(surface.surfaceId)
    return delivered
  }

  public async postTo(surfaceId: string, message: unknown): Promise<boolean> {
    const surface = this.surfaces.get(surfaceId)
    if (surface === undefined) return false
    try {
      return await surface.postMessage(message)
    } catch {
      return false
    }
  }

  public dispose(): void {
    const surfaces = [...this.surfaces.values()]
    this.surfaces.clear()
    for (const surface of surfaces) surface.dispose()
  }
}
