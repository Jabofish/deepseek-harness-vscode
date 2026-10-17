import type { BackendEvent } from '@dsh-vscode/domain'
import { isTranscriptOnlyEvent, type TranscriptWindowService } from './transcript-window.js'

/** Each live Webview owns its window, navigation, delivery acknowledgement and visibility. */
export class TranscriptWindowRegistry {
  private readonly windows = new Map<string, TranscriptWindowService>()

  public constructor(
    private readonly create: (surfaceId: string, isCurrent: () => boolean) => TranscriptWindowService,
    private readonly visible: (surfaceId: string) => boolean = () => true,
  ) {}

  public forSurface(surfaceId: string): TranscriptWindowService {
    let window = this.windows.get(surfaceId)
    if (window === undefined) {
      const created: TranscriptWindowService = this.create(
        surfaceId,
        () => this.windows.get(surfaceId) === created,
      )
      window = created
      window.setVisible(this.visible(surfaceId))
      this.windows.set(surfaceId, window)
    }
    return window
  }

  public accept(event: BackendEvent): boolean {
    for (const window of this.windows.values()) window.accept(event)
    // Transcript bodies never fall back to a broadcast when no view is open.
    return isTranscriptOnlyEvent(event)
  }

  public setVisible(surfaceId: string, visible: boolean): void {
    this.windows.get(surfaceId)?.setVisible(visible)
  }

  public remove(surfaceId: string): void {
    this.windows.get(surfaceId)?.dispose()
    this.windows.delete(surfaceId)
  }

  public dispose(): void {
    for (const window of this.windows.values()) window.dispose()
    this.windows.clear()
  }
}
