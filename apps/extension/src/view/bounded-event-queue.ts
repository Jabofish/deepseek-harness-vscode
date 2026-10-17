interface PendingPost {
  readonly run: () => Promise<boolean>
  readonly chars: number
  readonly finish: (delivered: boolean) => void
}

/** Serial transport work with explicit invalidation instead of an unbounded Promise chain. */
export class BoundedEventQueue {
  private readonly pending: PendingPost[] = []
  private chars = 0
  private running = false
  private invalidated = false
  private disposed = false

  public constructor(
    private readonly resync: () => Promise<void>,
    private readonly maxPending = 128,
    private readonly maxChars = 512 * 1024,
  ) {}

  public enqueue(run: () => Promise<boolean>, chars: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.pending.length >= this.maxPending || (this.running && this.chars + chars > this.maxChars)) {
      for (const entry of this.pending.splice(0)) entry.finish(false)
      this.chars = 0
      this.invalidated = true
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      this.pending.push({ run, chars, finish: resolve })
      this.chars += chars
      if (!this.running) {
        this.running = true
        void this.drain()
      }
    })
  }

  public dispose(): void {
    this.disposed = true
    this.invalidated = false
    for (const entry of this.pending.splice(0)) entry.finish(false)
    this.chars = 0
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && (this.pending.length > 0 || this.invalidated)) {
        if (this.invalidated) {
          this.invalidated = false
          try {
            await this.resync()
          } catch {
            /* The next ready handshake rereads authority. */
          }
        }
        const entry = this.pending.shift()
        if (entry === undefined) continue
        this.chars -= entry.chars
        try {
          entry.finish(await entry.run())
        } catch {
          entry.finish(false)
        }
      }
    } finally {
      this.running = false
    }
  }
}

export function eventPayloadCharacters(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 512 * 1024
  }
}
