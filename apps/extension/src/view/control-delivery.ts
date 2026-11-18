import type { HostMessage } from '@dsh-vscode/webview-protocol'
import { eventPayloadCharacters } from './bounded-event-queue.js'

type Event = Extract<HostMessage, { type: 'event' }>
const CONTROL_ACK_RETRY_DELAY_MS = 5_000
const CONTROL_POST_RETRY_DELAYS_MS = [100, 250, 500]
const CONTROL_POST_MAX_RETRY_DELAY_MS = 10_000
interface Pending {
  event: Event
  chars: number
  isCurrent: (() => boolean) | undefined
  readonly key: string | undefined
  readonly promise: Promise<boolean>
  readonly finish: (delivered: boolean) => void
}
interface Surface {
  readonly pending: Pending[]
  readonly latest: Map<string, Pending>
  readonly sourceSequences: Map<string, number>
  chars: number
  retryAttempt: number
  retryTimer?: ReturnType<typeof setTimeout>
  ackTimer?: ReturnType<typeof setTimeout>
  active?: { readonly entry: Pending; readonly sequence: number; mayHaveDelivered: boolean }
}

/** Each surface consumes one control frame at a time, with a bounded ordered mailbox. */
export class ControlDelivery {
  private readonly surfaces = new Map<string, Surface>()
  private disposed = false

  public constructor(
    private readonly post: (surfaceId: string, message: Event) => PromiseLike<boolean>,
    private readonly nextSequence: () => number,
    private readonly current: (surfaceId: string) => boolean,
    private readonly maxPending = 256,
    private readonly maxChars = 512 * 1024,
  ) {}

  public enqueue(surfaceId: string, event: Event, key?: string, isCurrent?: () => boolean): Promise<boolean> {
    if (this.disposed || !this.current(surfaceId)) return Promise.resolve(false)
    let surface = this.surfaces.get(surfaceId)
    if (surface === undefined) {
      surface = {
        pending: [],
        latest: new Map(),
        sourceSequences: new Map(),
        chars: 0,
        retryAttempt: 0,
      }
      this.surfaces.set(surfaceId, surface)
    }
    const sourceSequence =
      typeof event.payload === 'object' && event.payload !== null && 'sequence' in event.payload
        ? event.payload.sequence
        : undefined
    if (key !== undefined && typeof sourceSequence === 'number') {
      if (sourceSequence < (surface.sourceSequences.get(key) ?? -1)) return Promise.resolve(true)
      surface.sourceSequences.delete(key)
      surface.sourceSequences.set(key, sourceSequence)
      while (surface.sourceSequences.size > 2048)
        surface.sourceSequences.delete(surface.sourceSequences.keys().next().value!)
    }
    const previous = key === undefined ? undefined : surface.latest.get(key)
    const chars = eventPayloadCharacters(event)
    const count = surface.pending.length + (previous === undefined ? 1 : 0)
    const nextChars = surface.chars - (previous?.chars ?? 0) + chars
    if (count > this.maxPending || (count > 1 && nextChars > this.maxChars)) {
      // Authority has already consumed every source event. Only mailbox overflow
      // loses facts and needs a fresh baseline, scoped to this single surface.
      for (const pending of surface.pending) pending.finish(false)
      surface.pending.length = 0
      surface.latest.clear()
      surface.chars = 0
      const recovery = this.pending({ type: 'event', name: 'ui.resync', sequence: 0, payload: {} })
      surface.pending.push(recovery)
      surface.chars = recovery.chars
      this.pump(surfaceId, surface)
      return Promise.resolve(false)
    }
    if (previous !== undefined) {
      surface.chars = nextChars
      previous.event = event
      previous.chars = chars
      previous.isCurrent = isCurrent
      this.pump(surfaceId, surface)
      return previous.promise
    }
    // A lifecycle/append event fences snapshots: later replacements must never
    // move a state change across an interaction or subscription baseline.
    if (key === undefined) surface.latest.clear()
    const pending = this.pending(event, key, isCurrent)
    surface.pending.push(pending)
    surface.chars += chars
    if (key !== undefined) surface.latest.set(key, pending)
    this.pump(surfaceId, surface)
    return pending.promise
  }

  private pending(event: Event, key?: string, isCurrent?: () => boolean): Pending {
    let finish!: Pending['finish']
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve
    })
    return { event, chars: eventPayloadCharacters(event), key, isCurrent, promise, finish }
  }

  private pump(surfaceId: string, surface: Surface): void {
    if (this.disposed || this.surfaces.get(surfaceId) !== surface || surface.active !== undefined) return
    if (surface.retryTimer !== undefined) return
    if (!this.current(surfaceId)) {
      this.forget(surfaceId)
      return
    }
    const entry = surface.pending.shift()
    if (entry === undefined) return
    surface.chars -= entry.chars
    if (entry.key !== undefined && surface.latest.get(entry.key) === entry) surface.latest.delete(entry.key)
    if (entry.isCurrent?.() === false) {
      entry.finish(true)
      this.pump(surfaceId, surface)
      return
    }
    const active = { entry, sequence: this.nextSequence(), mayHaveDelivered: false }
    surface.active = active
    this.transmit(surfaceId, surface, active)
  }

  private transmit(surfaceId: string, surface: Surface, active: NonNullable<Surface['active']>): void {
    const { entry } = active
    void Promise.resolve()
      .then(() => {
        if (this.disposed || this.surfaces.get(surfaceId) !== surface || surface.active !== active)
          return false
        if (entry.isCurrent?.() === false) {
          this.complete(surfaceId, surface, active)
          return false
        }
        this.waitForAck(surfaceId, surface, active)
        return this.post(surfaceId, {
          ...entry.event,
          sequence: active.sequence,
          requiresAck: true,
        })
      })
      .then(
        (posted) => {
          if (this.surfaces.get(surfaceId) !== surface || surface.active !== active) return
          if (posted) active.mayHaveDelivered = true
          else this.failed(surfaceId, surface, active)
        },
        () => {
          if (this.surfaces.get(surfaceId) === surface && surface.active === active)
            this.failed(surfaceId, surface, active)
        },
      )
  }

  private waitForAck(surfaceId: string, surface: Surface, active: NonNullable<Surface['active']>): void {
    if (surface.active !== active) return
    surface.ackTimer = setTimeout(() => {
      delete surface.ackTimer
      if (surface.active !== active) return
      if (!this.current(surfaceId)) {
        this.forget(surfaceId)
        return
      }
      // Once IPC outcome is uncertain, reuse this sequence to deduplicate
      // late and retried delivery. A missing native receipt cannot block ACKs.
      active.mayHaveDelivered = true
      this.transmit(surfaceId, surface, active)
    }, CONTROL_ACK_RETRY_DELAY_MS)
    surface.ackTimer.unref?.()
  }

  private failed(surfaceId: string, surface: Surface, active: NonNullable<Surface['active']>): void {
    if (active.mayHaveDelivered) return
    if (surface.ackTimer !== undefined) clearTimeout(surface.ackTimer)
    delete surface.ackTimer
    delete surface.active
    // Preserve the last interaction even if there is no subsequent traffic.
    // After the fast attempts, probe only this surface on a slower cadence.
    surface.pending.unshift(active.entry)
    surface.chars += active.entry.chars
    active.entry.finish(false)
    const delay = CONTROL_POST_RETRY_DELAYS_MS[surface.retryAttempt] ?? CONTROL_POST_MAX_RETRY_DELAY_MS
    surface.retryAttempt = Math.min(surface.retryAttempt + 1, CONTROL_POST_RETRY_DELAYS_MS.length)
    surface.retryTimer = setTimeout(() => {
      delete surface.retryTimer
      this.pump(surfaceId, surface)
    }, delay)
    surface.retryTimer.unref?.()
  }

  public acknowledge(surfaceId: string, sequence: number): void {
    const surface = this.surfaces.get(surfaceId)
    const active = surface?.active
    if (surface === undefined || active?.sequence !== sequence) return
    this.complete(surfaceId, surface, active)
  }

  private complete(surfaceId: string, surface: Surface, active: NonNullable<Surface['active']>): void {
    if (surface.ackTimer !== undefined) clearTimeout(surface.ackTimer)
    delete surface.ackTimer
    delete surface.active
    surface.retryAttempt = 0
    active.entry.finish(true)
    this.pump(surfaceId, surface)
  }

  public forget(surfaceId: string): void {
    const surface = this.surfaces.get(surfaceId)
    this.surfaces.delete(surfaceId)
    if (surface?.retryTimer !== undefined) clearTimeout(surface.retryTimer)
    if (surface?.ackTimer !== undefined) clearTimeout(surface.ackTimer)
    surface?.active?.entry.finish(false)
    for (const entry of surface?.pending ?? []) entry.finish(false)
  }

  public reset(): void {
    for (const surfaceId of this.surfaces.keys()) this.forget(surfaceId)
  }

  public dispose(): void {
    this.disposed = true
    this.reset()
  }
}
