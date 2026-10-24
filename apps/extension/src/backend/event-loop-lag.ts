import type * as vscode from 'vscode'

export interface EventLoopLagMonitorOptions {
  /** Sampling cadence. Defaults to 100ms. */
  readonly intervalMs?: number
  /** Trailing window retained for `recentMaxLagMs`. Defaults to 10s. */
  readonly windowMs?: number
  /** Monotonic clock source, injectable for tests. Defaults to `performance.now`. */
  readonly now?: () => number
}

interface LagSample {
  readonly time: number
  readonly lagMs: number
}

/**
 * Samples the Extension Host event loop's responsiveness with an unref'd
 * timeout chain. When the loop stalls, the next tick fires late and that
 * lateness is recorded as a lag sample; a `setInterval` would instead coalesce
 * ticks and under-report the stall. A connection drop that follows a large
 * recent lag implicates a synchronous host stall (which starves the WebSocket
 * heartbeat), while a drop with ~0 lag points at the transport instead.
 */
export class EventLoopLagMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined
  private expected = 0
  private readonly samples: LagSample[] = []
  private disposed = false
  private readonly intervalMs: number
  private readonly windowMs: number
  private readonly now: () => number

  public constructor(options: EventLoopLagMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? 100
    this.windowMs = options.windowMs ?? 10_000
    this.now = options.now ?? (() => performance.now())
  }

  public start(): void {
    if (this.timer !== undefined || this.disposed) return
    this.expected = this.now() + this.intervalMs
    this.timer = setTimeout(this.tick, this.intervalMs)
    this.timer.unref()
  }

  /** Largest lag observed within the trailing window, in whole milliseconds. */
  public recentMaxLagMs(): number {
    if (this.timer === undefined || this.disposed) return 0
    const now = this.now()
    const cutoff = now - this.windowMs
    // A socket's close microtask may run before our overdue timer callback.
    // Include that still-pending lateness rather than misclassifying it as zero.
    let max = Math.max(0, now - this.expected)
    for (const sample of this.samples) if (sample.time >= cutoff && sample.lagMs > max) max = sample.lagMs
    return Math.round(max)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.samples.length = 0
  }

  private readonly tick = (): void => {
    if (this.disposed) return
    const now = this.now()
    const lagMs = Math.max(0, now - this.expected)
    this.expected = now + this.intervalMs
    this.samples.push({ time: now, lagMs })
    const cutoff = now - this.windowMs
    const firstFresh = this.samples.findIndex((sample) => sample.time >= cutoff)
    if (firstFresh === -1) this.samples.length = 0
    else if (firstFresh > 0) this.samples.splice(0, firstFresh)
    this.timer = setTimeout(this.tick, this.intervalMs)
    this.timer.unref()
  }
}
