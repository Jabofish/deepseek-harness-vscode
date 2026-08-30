/**
 * Host-side lifecycle primitive for future feature requests. The Webview can
 * time out locally, but only this owner-scoped ledger is allowed to abort the
 * actual Host operation.
 */

export type FeatureRequestState = 'pending' | 'cancelled' | 'completed'

interface FeatureRequestEntry {
  readonly ownerId: string
  readonly connectionGeneration: number
  readonly controller: AbortController
  state: FeatureRequestState
}

export class FeatureRequestLedger {
  private readonly entries = new Map<string, FeatureRequestEntry>()

  public register(requestId: string, ownerId: string, connectionGeneration: number): AbortSignal | undefined {
    if (
      requestId.length === 0 ||
      requestId.length > 256 ||
      ownerId.length === 0 ||
      ownerId.length > 256 ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0 ||
      this.entries.has(requestId)
    )
      return undefined

    const controller = new AbortController()
    this.entries.set(requestId, {
      ownerId,
      connectionGeneration,
      controller,
      state: 'pending',
    })
    return controller.signal
  }

  public cancel(requestId: string, ownerId: string, connectionGeneration: number): boolean {
    const entry = this.entries.get(requestId)
    if (!this.matches(entry, ownerId, connectionGeneration) || entry.state !== 'pending') return false
    entry.state = 'cancelled'
    entry.controller.abort()
    return true
  }

  public complete(requestId: string, ownerId: string, connectionGeneration: number): boolean {
    const entry = this.entries.get(requestId)
    if (!this.matches(entry, ownerId, connectionGeneration) || entry.state !== 'pending') return false
    entry.state = 'completed'
    return true
  }

  public state(requestId: string): FeatureRequestState | undefined {
    return this.entries.get(requestId)?.state
  }

  public disposeOwned(ownerId: string, connectionGeneration?: number): number {
    let disposed = 0
    for (const [requestId, entry] of this.entries) {
      if (
        entry.ownerId === ownerId &&
        (connectionGeneration === undefined || entry.connectionGeneration === connectionGeneration)
      ) {
        if (entry.state === 'pending') {
          entry.state = 'cancelled'
          entry.controller.abort()
        }
        this.entries.delete(requestId)
        disposed += 1
      }
    }
    return disposed
  }

  public clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.state === 'pending') {
        entry.state = 'cancelled'
        entry.controller.abort()
      }
    }
    this.entries.clear()
  }

  public get size(): number {
    return this.entries.size
  }

  private matches(
    entry: FeatureRequestEntry | undefined,
    ownerId: string,
    connectionGeneration: number,
  ): entry is FeatureRequestEntry {
    return (
      entry !== undefined && entry.ownerId === ownerId && entry.connectionGeneration === connectionGeneration
    )
  }
}
