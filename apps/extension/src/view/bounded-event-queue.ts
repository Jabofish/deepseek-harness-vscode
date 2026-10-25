interface PendingPost {
  readonly chars: number
  readonly finish: (delivered: boolean) => void
  readonly priority: boolean
}

interface LatestPost {
  run: () => Promise<boolean>
  chars: number
  readonly priority: boolean
  sequence: number | undefined
  readonly promise: Promise<boolean>
  readonly finish: (delivered: boolean) => void
}

interface LatestDelivery {
  count: number
  sequence: number | undefined
}

export interface BoundedQueueRecoveryInfo {
  readonly priority: boolean
}

/** Bound IPC receipts and latest-state snapshots; lifecycle frames preserve source order. */
export class BoundedEventQueue {
  private readonly active = new Set<PendingPost>()
  private readonly counts = [0, 0]
  private readonly chars = [0, 0]
  private readonly latest = new Map<string, LatestPost>()
  private readonly latestDeliveries = new Map<string, LatestDelivery>()
  private readonly waitingCounts = [0, 0]
  private readonly waitingChars = [0, 0]
  private flushScheduled = false
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private lastPriorityRecoveryAt: number | undefined
  private recovering = false
  private invalidated = false
  private invalidatedPriority = false
  private disposed = false

  public constructor(
    private readonly resync: (info?: BoundedQueueRecoveryInfo) => Promise<void>,
    private readonly maxPending = 128,
    private readonly maxChars = 512 * 1024,
  ) {}

  public enqueue(run: () => Promise<boolean>, chars: number, priority = false): Promise<boolean> {
    // A lifecycle/append frame fences earlier snapshots. Never move an older
    // queued snapshot across a subscription baseline or an interaction event.
    this.flushLatest(true)
    return this.enqueueNow(run, chars, priority)
  }

  /** One posted snapshot and one bounded latest replacement per semantic key. */
  public enqueueLatest(
    key: string,
    run: () => Promise<boolean>,
    chars: number,
    priority = false,
    sequence?: number,
  ): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    const pending = this.latest.get(key)
    const delivery = this.latestDeliveries.get(key)
    const previousSequence = pending?.sequence ?? delivery?.sequence
    if (previousSequence !== undefined && sequence !== undefined && sequence < previousSequence)
      return pending?.promise ?? Promise.resolve(true)
    if (pending === undefined && delivery === undefined && !this.hasInFlight(priority))
      return this.sendLatest(key, run, chars, priority, sequence)
    const lane = priority ? 1 : 0
    const nextChars = this.waitingChars[lane]! - (pending?.chars ?? 0) + chars
    const nextCount = this.waitingCounts[lane]! + (pending === undefined ? 1 : 0)
    // Replacements are charged by their NEW payload size, not the first frame.
    if (nextCount > this.maxPending || (nextCount > 1 && nextChars > this.maxChars)) {
      if (pending !== undefined) this.takeLatest(key)?.finish(false)
      this.invalidate(priority)
      return Promise.resolve(false)
    }
    if (pending !== undefined) {
      this.waitingChars[lane] = nextChars
      pending.run = run
      pending.chars = chars
      pending.sequence = sequence
      return pending.promise
    }
    let finish!: (delivered: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    this.latest.set(key, { run, chars, priority, sequence, promise, finish })
    this.waitingCounts[lane] = nextCount
    this.waitingChars[lane] = nextChars
    if (!this.flushScheduled) {
      this.flushScheduled = true
      void Promise.resolve().then(() => {
        this.flushScheduled = false
        this.flushLatest(false)
      })
    }
    return promise
  }

  private takeLatest(key: string): LatestPost | undefined {
    const pending = this.latest.get(key)
    if (pending === undefined) return undefined
    this.latest.delete(key)
    const lane = pending.priority ? 1 : 0
    this.waitingCounts[lane]! -= 1
    this.waitingChars[lane]! -= pending.chars
    return pending
  }

  private flushLatest(barrier: boolean): void {
    for (const key of [...this.latest.keys()]) {
      if (!barrier && this.latestDeliveries.has(key)) continue
      const pending = this.takeLatest(key)
      if (pending === undefined) continue
      void this.sendLatest(key, pending.run, pending.chars, pending.priority, pending.sequence).then(
        pending.finish,
      )
    }
  }

  private sendLatest(
    key: string,
    run: () => Promise<boolean>,
    chars: number,
    priority: boolean,
    sequence: number | undefined,
  ): Promise<boolean> {
    const delivery = this.latestDeliveries.get(key) ?? { count: 0, sequence }
    delivery.count++
    delivery.sequence = sequence
    this.latestDeliveries.set(key, delivery)
    return this.enqueueNow(run, chars, priority).finally(() => {
      if (this.latestDeliveries.get(key) !== delivery) return
      if (--delivery.count > 0) return
      this.latestDeliveries.delete(key)
      const pending = this.takeLatest(key)
      if (pending !== undefined)
        void this.sendLatest(key, pending.run, pending.chars, pending.priority, pending.sequence).then(
          pending.finish,
        )
    })
  }

  private enqueueNow(run: () => Promise<boolean>, chars: number, priority: boolean): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    // Reserve independent capacity for control traffic. A stalled renderer
    // cannot consume the control budget with transcript delivery receipts.
    const lane = priority ? 1 : 0
    if (
      this.counts[lane]! >= this.maxPending ||
      (this.counts[lane]! > 0 && this.chars[lane]! + chars > this.maxChars)
    ) {
      this.invalidate(priority)
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

  public hasInFlight(priority = false): boolean {
    const lane = priority ? 1 : 0
    return this.counts[lane]! > 0
  }

  public dispose(): void {
    this.disposed = true
    this.invalidated = false
    this.invalidatedPriority = false
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    for (const pending of this.latest.values()) pending.finish(false)
    this.latest.clear()
    this.latestDeliveries.clear()
    this.waitingCounts.fill(0)
    this.waitingChars.fill(0)
    for (const entry of this.active) entry.finish(false)
    this.active.clear()
    this.counts.fill(0)
    this.chars.fill(0)
  }

  /** Ask for the same resync a rejected frame triggers, keeping the queue. */
  public invalidate(priority = true): void {
    if (this.disposed) return
    this.invalidated = true
    if (priority) this.invalidatedPriority = true
    this.scheduleRecovery()
  }

  private scheduleRecovery(): void {
    if (this.disposed || this.recovering || this.recoveryTimer !== undefined || !this.invalidated) return
    const delay =
      this.invalidatedPriority && this.lastPriorityRecoveryAt !== undefined
        ? Math.max(0, 1_000 - (performance.now() - this.lastPriorityRecoveryAt))
        : 0
    if (delay > 0) {
      this.recoveryTimer = setTimeout(() => {
        this.recoveryTimer = undefined
        this.scheduleRecovery()
      }, delay)
    } else void this.recover()
  }

  private async recover(): Promise<void> {
    this.recovering = true
    const priority = this.invalidatedPriority
    this.invalidated = false
    this.invalidatedPriority = false
    if (priority) this.lastPriorityRecoveryAt = performance.now()
    try {
      await this.resync({ priority })
    } catch {
      /* The next ready handshake rereads authority. */
    } finally {
      this.recovering = false
      this.scheduleRecovery()
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
