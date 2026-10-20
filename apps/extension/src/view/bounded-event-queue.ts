interface PendingPost {
  readonly chars: number
  readonly finish: (delivered: boolean) => void
  readonly priority: boolean
}

/** Invoke IPC in source order; delivery receipts never serialize later messages. */
export class BoundedEventQueue {
  private readonly active = new Set<PendingPost>()
  private readonly counts = [0, 0]
  private readonly chars = [0, 0]
  private recovering = false
  private invalidated = false
  private disposed = false

  public constructor(
    private readonly resync: () => Promise<void>,
    private readonly maxPending = 128,
    private readonly maxChars = 512 * 1024,
  ) {}

  public enqueue(run: () => Promise<boolean>, chars: number, priority = false): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    // Reserve independent capacity for control traffic. A stalled renderer
    // cannot consume the control budget with transcript delivery receipts.
    const lane = priority ? 1 : 0
    if (
      this.counts[lane]! >= this.maxPending ||
      (this.counts[lane]! > 0 && this.chars[lane]! + chars > this.maxChars)
    ) {
      this.invalidate()
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const entry: PendingPost = { chars, finish: resolve, priority }
      this.active.add(entry)
      this.counts[lane]! += 1
      this.chars[lane]! += chars
      const finish = (delivered: boolean): void => {
        if (!this.active.delete(entry)) return
        this.counts[lane]! -= 1
        this.chars[lane]! -= chars
        resolve(delivered)
      }
      try {
        void run().then(finish, () => finish(false))
      } catch {
        finish(false)
      }
    })
  }

  public dispose(): void {
    this.disposed = true
    this.invalidated = false
    for (const entry of this.active) entry.finish(false)
    this.active.clear()
    this.counts.fill(0)
    this.chars.fill(0)
  }

  /** Ask for the same resync a rejected frame triggers, keeping the queue. */
  public invalidate(): void {
    if (this.disposed) return
    this.invalidated = true
    if (!this.recovering) void this.recover()
  }

  private async recover(): Promise<void> {
    this.recovering = true
    try {
      while (!this.disposed && this.invalidated) {
        this.invalidated = false
        try {
          await this.resync()
        } catch {
          /* The next ready handshake rereads authority. */
        }
      }
    } finally {
      this.recovering = false
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
