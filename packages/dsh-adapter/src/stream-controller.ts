import { AppError, type AsyncEventSource, type BackendEvent } from '@dsh-vscode/domain'

import type { DshTransport } from './contracts.js'
import { redactText, safePayload } from './redaction.js'
import { assertCanonicalSessionEvent, rc6Mapper } from './versions/rc6/mapper.js'

export interface DshStreamControllerOptions {
  /** Optional version-specific logical stream (for example alpha Remote mux). */
  readonly streamSource?: (signal: AbortSignal) => AsyncIterable<unknown>
  /** Shared alpha streams do not own the transport lifecycle. */
  readonly closeTransport?: boolean
}

export type StreamRecovery = (
  sessionId: string,
  fromSequence: number,
  toSequence: number,
  signal: AbortSignal,
) => Promise<readonly BackendEvent[]>

interface OrderedSessionDelivery {
  nextSequence: number
  readonly pending: Map<number, BackendEvent[]>
  /** Durable positions occupied by filtered advisory rows. */
  readonly skippedSequences: Set<number>
  recoveryThrough?: number
  draining: boolean
  drainSignal?: AbortSignal
  readonly abort: AbortController
}

/** One shared mux/host reader for every consumer in an Extension Host. */
export class DshStreamController implements AsyncEventSource<BackendEvent> {
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly lastSequences = new Map<string, number>()
  /** Alpha session/follow sends its history snapshot before this baseline. */
  private readonly subscribedSessions = new Set<string>()
  /** Durable conversation frames are buffered and emitted in sequence order. */
  private readonly orderedDeliveries = new Map<string, OrderedSessionDelivery>()
  /** Projection frames share the durable event sequence, so dedupe them per key. */
  private readonly lastProjectionSequences = new Map<string, Map<string, number>>()
  /** A complete projection baseline also fences keys omitted from its values. */
  private readonly projectionBaselines = new Map<string, number>()
  /** Alpha13 transient frames have a separate local sequence space. */
  private readonly lastTransientSequences = new Map<string, number>()
  /** Session/follow emits its bounded history before the subscription cursor. */
  private readonly pendingSessionSnapshots = new Map<string, BackendEvent[]>()
  private lifetime: AbortController | undefined
  private reading: Promise<void> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private restartTask: Promise<void> | undefined
  private closed = false

  public constructor(
    private readonly transport: DshTransport,
    private readonly observe?: (event: BackendEvent) => void,
    private readonly recover?: StreamRecovery,
    private readonly options: DshStreamControllerOptions = {},
  ) {}

  public subscribe(listener: (event: BackendEvent) => void): () => void {
    if (this.closed) return () => undefined
    this.listeners.add(listener)
    if (this.reading === undefined) this.startReading()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
        this.retryTimer = undefined
        this.lifetime?.abort()
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.lifetime?.abort()
    this.clearOrderedDeliveries()
    this.listeners.clear()
    await this.reading?.catch(() => undefined)
    await this.restartTask?.catch(() => undefined)
    if (this.options.closeTransport !== false) await this.transport.close()
  }

  /**
   * Re-open one logical stream without dropping its subscribers. Alpha13 uses
   * this both when a session becomes active again and when a transient frame
   * gap proves that the bounded receive queue discarded process-local chunks.
   */
  public async restart(): Promise<void> {
    if (this.closed) return
    if (this.restartTask !== undefined) return this.restartTask
    const task = (async (): Promise<void> => {
      if (this.retryTimer !== undefined) clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      this.retryAttempt = 0
      this.lastSequences.clear()
      this.clearOrderedDeliveries()
      this.lastProjectionSequences.clear()
      this.projectionBaselines.clear()
      this.lastTransientSequences.clear()
      this.subscribedSessions.clear()
      this.pendingSessionSnapshots.clear()
      const reading = this.reading
      this.lifetime?.abort()
      await reading?.catch(() => undefined)
      if (!this.closed && this.listeners.size > 0 && this.reading === undefined) this.startReading()
    })()
    this.restartTask = task
    try {
      await task
    } finally {
      if (this.restartTask === task) this.restartTask = undefined
    }
  }

  private startReading(): void {
    if (this.closed || this.listeners.size === 0 || this.reading !== undefined) return
    if (this.options.streamSource !== undefined) {
      // A streamSource session starts every generation with a fresh bounded
      // snapshot. Keep the durable watermark for recovery, but make the next
      // session/subscribed frame establish the snapshot boundary again.
      this.subscribedSessions.clear()
      this.pendingSessionSnapshots.clear()
    }
    const lifetime = new AbortController()
    this.lifetime = lifetime
    this.reading = this.runGeneration(lifetime)
      .catch((error: unknown) => {
        if (!this.closed && !lifetime.signal.aborted) this.scheduleReconnect(lifetime, error)
      })
      .finally(() => {
        // Sample before the teardown abort below: after it, every settled
        // generation would look "aborted" and the restart guard below would
        // bypass the reconnect backoff for natural failures.
        const strandedSubscriber = lifetime.signal.aborted
        lifetime.abort()
        this.reading = undefined
        if (this.lifetime === lifetime) this.lifetime = undefined
        // An unsubscribe-triggered abort can leave a freshly subscribed
        // listener stranded: subscribe() skipped it because `reading` was
        // still set while the aborted generation unwound. Restart only for
        // that case; natural failures keep the backoff path in
        // scheduleReconnect, so a down host cannot hot-loop reconnects.
        if (strandedSubscriber && !this.closed && this.listeners.size > 0) this.startReading()
      })
  }

  private async runGeneration(lifetime: AbortController): Promise<void> {
    const generation = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, generation.signal])
    const tasks: Promise<void>[] =
      this.options.streamSource === undefined
        ? [
            Promise.resolve().then(() =>
              this.readStream(
                this.transport.openMuxStream?.(signal) ?? this.transport.openEventStream(signal),
                signal,
              ),
            ),
          ]
        : [Promise.resolve().then(() => this.readStream(this.options.streamSource!(signal), signal))]
    if (this.options.streamSource === undefined && this.transport.openHostStream !== undefined)
      tasks.push(
        Promise.resolve().then(() => this.readStream(this.transport.openHostStream!(signal), signal)),
      )
    try {
      await Promise.race(tasks)
      if (!lifetime.signal.aborted) throw new Error('DSH event stream ended.')
    } finally {
      // Whichever logical stream ends first invalidates the whole generation.
      // Await both readers before the outer reconnect timer is allowed to open
      // another pair, otherwise a slow old host reader can overlap the next
      // generation and publish stale events.
      generation.abort()
      await Promise.allSettled(tasks)
    }
  }

  private scheduleReconnect(lifetime: AbortController, error: unknown): void {
    this.emit({ type: 'connection.lost', reason: safeReason(error) })
    if (this.closed || this.listeners.size === 0 || this.lifetime !== lifetime) return
    const attempt = this.retryAttempt
    this.retryAttempt = Math.min(attempt + 1, 8)
    const base = Math.min(10_000, 250 * 2 ** attempt)
    const jitter = Math.floor(base * 0.2 * Math.random())
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.closed && this.listeners.size > 0) this.startReading()
    }, base + jitter)
  }

  private async readStream(stream: AsyncIterable<unknown>, signal: AbortSignal): Promise<void> {
    let receivedFrame = false
    try {
      for await (const envelope of stream) {
        if (this.closed || signal.aborted) return
        const event = normalizeEnvelope(envelope)
        if (event !== undefined) {
          // A delivered frame proves this generation's transport is alive.
          // Restart the reconnect ladder, or streamSource-based controllers
          // (alpha workspace/session streams) that never see a
          // session/subscribed frame would ratchet their backoff up across
          // healthy generations.
          if (!receivedFrame) {
            receivedFrame = true
            this.retryAttempt = 0
          }
          this.accept(event, signal)
        }
      }
      if (!this.closed && !signal.aborted) throw new Error('DSH event stream ended.')
    } catch (error) {
      if (!this.closed && !signal.aborted) throw error
    }
  }

  private accept(event: BackendEvent, signal: AbortSignal): void {
    if (signal.aborted) return
    if (event.type === 'session.removed') {
      this.lastSequences.delete(event.sessionId)
      this.deleteOrderedDelivery(event.sessionId)
      this.lastProjectionSequences.delete(event.sessionId)
      this.projectionBaselines.delete(event.sessionId)
      this.lastTransientSequences.delete(event.sessionId)
      this.subscribedSessions.delete(event.sessionId)
      this.pendingSessionSnapshots.delete(event.sessionId)
    }
    if (
      this.options.streamSource !== undefined &&
      event.type !== 'session.subscribed' &&
      event.type !== 'session.removed'
    ) {
      const sessionId = eventSessionId(event)
      if (sessionId !== undefined && !this.subscribedSessions.has(sessionId)) {
        // Only durable rows belong to the bounded pre-subscription snapshot.
        // Host-only notices (for example an abandoned assistant attempt) and
        // cursorless live frames have no replayable DSH sequence; holding them
        // for a subscription marker would either delay them indefinitely or
        // lose them when a stream ends before that marker arrives.
        if (event.sequence !== undefined) {
          const snapshot = this.pendingSessionSnapshots.get(sessionId) ?? []
          snapshot.push(event)
          this.pendingSessionSnapshots.set(sessionId, snapshot)
        } else this.emit(event)
        return
      }
    }
    if (event.type === 'session.subscribed') {
      const snapshot = this.pendingSessionSnapshots.get(event.sessionId)
      if (snapshot !== undefined) {
        this.pendingSessionSnapshots.delete(event.sessionId)
        this.acceptSessionSnapshot(event, snapshot, signal)
        return
      }
      this.subscribedSessions.add(event.sessionId)
      this.lastTransientSequences.delete(event.sessionId)
      const previous = this.lastSequences.get(event.sessionId)
      if (previous !== undefined && event.lastSequence < previous) {
        this.lastProjectionSequences.delete(event.sessionId)
        this.projectionBaselines.delete(event.sessionId)
      } else this.truncateProjectionSequences(event.sessionId, event.lastSequence)
      this.rememberProjectionBaseline(event)
      if (previous === undefined) {
        this.lastSequences.set(event.sessionId, event.lastSequence)
        this.orderedDeliveries.set(event.sessionId, createOrderedDelivery(event.lastSequence + 1))
      } else if (event.lastSequence > previous) {
        // The v1 mux has no client-side resume hook ("since" is ignored), so a
        // re-subscribe above the cached watermark means the missed range is
        // only reachable through history. Keep reading the host in parallel,
        // but hold later durable frames behind this recovery window.
        const delivery =
          this.orderedDeliveries.get(event.sessionId) ??
          (() => {
            const created = createOrderedDelivery(previous + 1)
            this.orderedDeliveries.set(event.sessionId, created)
            return created
          })()
        delivery.recoveryThrough = Math.max(delivery.recoveryThrough ?? -1, event.lastSequence)
        this.lastSequences.set(event.sessionId, event.lastSequence)
      } else if (event.lastSequence < previous) {
        // The v1 mux has no client-side resume hook ("since" is ignored), so
        // the host's subscribed frame is the authoritative log baseline. A
        // lower value means the host log no longer contains what this cache
        // holds; keeping the stale watermark would silently drop the host's
        // new event epoch below it. Follow the baseline down instead.
        this.lastSequences.set(event.sessionId, event.lastSequence)
        this.replaceOrderedDelivery(event.sessionId, event.lastSequence + 1)
      } else if (!this.orderedDeliveries.has(event.sessionId)) {
        // Alpha session/follow may have emitted a bounded history snapshot
        // before this cursor. Those frames were intentionally delivered
        // directly; start the ordered live tail immediately after the cursor.
        this.orderedDeliveries.set(event.sessionId, createOrderedDelivery(event.lastSequence + 1))
      }
      this.retryAttempt = 0
      this.emit(event)
      const delivery = this.orderedDeliveries.get(event.sessionId)
      if (delivery !== undefined && delivery.nextSequence <= event.lastSequence) {
        // If the previous generation was aborted while a hole was being
        // recovered, a reconnect may repeat the same host baseline. Re-arm
        // that baseline instead of leaving the unfinished prefix stranded.
        delivery.recoveryThrough = Math.max(delivery.recoveryThrough ?? -1, event.lastSequence)
        this.startOrderedDrain(event.sessionId, signal)
      } else if (event.lastSequence > (previous ?? event.lastSequence)) {
        this.startOrderedDrain(event.sessionId, signal)
      }
      return
    }
    const sessionId = eventSessionId(event)
    const sequence = event.sequence
    const transientSequence = eventTransientSequence(event)
    if (
      sessionId !== undefined &&
      transientSequence !== undefined &&
      this.options.streamSource !== undefined
    ) {
      const previousTransient = this.lastTransientSequences.get(sessionId)
      if (previousTransient !== undefined && transientSequence > previousTransient + 1) {
        // Unlike durable frames, transient assistant chunks cannot be
        // recovered from session.history. A queue drop is therefore healed by
        // taking the stream's authoritative snapshot/baseline again.
        void this.restart()
        return
      }
      if (previousTransient !== undefined && transientSequence <= previousTransient) return
      this.lastTransientSequences.set(sessionId, transientSequence)
    }
    if (sessionId === undefined || sequence === undefined) {
      this.emit(event)
      return
    }
    if (event.type === 'session.projection') {
      if (!this.rememberProjectionSequence(sessionId, event.key, sequence)) return
      this.emit(event)
      return
    }
    if (this.options.streamSource !== undefined && !this.subscribedSessions.has(sessionId)) {
      // A session/follow snapshot is a bounded history sample and is emitted
      // before its session/subscribed cursor. A sample can legitimately start
      // above sequence zero; do not manufacture a gap until the live baseline
      // has been established.
      const previous = this.lastSequences.get(sessionId)
      if (previous !== undefined && sequence <= previous) return
      this.lastSequences.set(sessionId, sequence)
      this.emit(event)
      return
    }
    const previous = this.lastSequences.get(sessionId)
    if (previous === undefined) this.lastSequences.set(sessionId, -1)
    const delivery =
      this.orderedDeliveries.get(sessionId) ??
      (() => {
        const created = createOrderedDelivery(0)
        this.orderedDeliveries.set(sessionId, created)
        return created
      })()
    if (sequence < delivery.nextSequence) return
    const pending = delivery.pending.get(sequence) ?? []
    if (pending.some((candidate) => sameBackendEvent(candidate, event))) return
    pending.push(event)
    delivery.pending.set(sequence, pending)
    this.lastSequences.set(sessionId, Math.max(this.lastSequences.get(sessionId) ?? -1, sequence))
    this.retryAttempt = 0
    this.startOrderedDrain(sessionId, signal)
  }

  /** Reconcile a bounded Session/follow snapshot with the retained watermark. */
  private acceptSessionSnapshot(
    event: Extract<BackendEvent, { readonly type: 'session.subscribed' }>,
    snapshot: readonly BackendEvent[],
    signal: AbortSignal,
  ): void {
    this.subscribedSessions.add(event.sessionId)
    // A new Session/follow baseline starts a new process-local projection
    // epoch even when the durable log happens to reuse lower sequence values.
    // Clear these side channels before replaying the snapshot so the first
    // transient frame/projection of the new epoch cannot be rejected by stale
    // state from the previous generation.
    this.lastTransientSequences.delete(event.sessionId)
    const orderedSnapshot = [...snapshot].sort(
      (left, right) =>
        (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER),
    )
    const previous = this.lastSequences.get(event.sessionId)
    if (previous !== undefined && event.lastSequence < previous) {
      this.lastProjectionSequences.delete(event.sessionId)
      this.projectionBaselines.delete(event.sessionId)
    } else this.truncateProjectionSequences(event.sessionId, event.lastSequence)
    this.rememberProjectionBaseline(event)

    // A first snapshot, or a host log that moved backwards, is authoritative
    // for the rows it contains. Emit those rows even when they are below the
    // previous watermark; otherwise a restarted DSH process loses the new
    // epoch before the lower session/subscribed cursor can reset delivery.
    if (previous === undefined || event.lastSequence < previous) {
      const emittedSnapshot: BackendEvent[] = []
      for (const candidate of orderedSnapshot) {
        // A retried follow page can repeat an identical durable row before the
        // cursor marker arrives. Dedupe exact records only: distinct projection
        // keys or distinct events sharing one DSH sequence are still valid.
        if (emittedSnapshot.some((existing) => sameBackendEvent(existing, candidate))) continue
        if (
          candidate.type === 'session.projection' &&
          (candidate.sequence === undefined ||
            !this.rememberProjectionSequence(event.sessionId, candidate.key, candidate.sequence))
        )
          continue
        emittedSnapshot.push(candidate)
        this.emit(candidate)
      }
      this.lastSequences.set(event.sessionId, event.lastSequence)
      if (previous === undefined)
        this.orderedDeliveries.set(event.sessionId, createOrderedDelivery(event.lastSequence + 1))
      else this.replaceOrderedDelivery(event.sessionId, event.lastSequence + 1)
      this.retryAttempt = 0
      this.emit(event)
      return
    }

    // A reconnect snapshot is only a bounded tail. Keep it behind the old
    // cursor so the recovery callback can fill the unseen prefix, then let
    // the queued tail drain in durable sequence order.
    const delivery =
      this.orderedDeliveries.get(event.sessionId) ??
      (() => {
        const created = createOrderedDelivery(previous + 1)
        this.orderedDeliveries.set(event.sessionId, created)
        return created
      })()
    for (const candidate of orderedSnapshot) {
      const sequence = candidate.sequence
      if (sequence === undefined || sequence < delivery.nextSequence) continue
      if (
        candidate.type === 'session.projection' &&
        !this.rememberProjectionSequence(event.sessionId, candidate.key, sequence)
      ) {
        delivery.skippedSequences.add(sequence)
        continue
      }
      const pending = delivery.pending.get(sequence) ?? []
      if (pending.some((existing) => sameBackendEvent(existing, candidate))) continue
      pending.push(candidate)
      delivery.pending.set(sequence, pending)
    }
    this.lastSequences.set(event.sessionId, Math.max(previous, event.lastSequence))
    delivery.recoveryThrough = Math.max(delivery.recoveryThrough ?? -1, event.lastSequence)
    this.retryAttempt = 0
    this.emit(event)
    this.startOrderedDrain(event.sessionId, signal)
  }

  /**
   * Drain one session's durable queue without suspending the host read loop.
   * Later frames can continue accumulating in `pending` while history fills a
   * hole, but consumers never see a later sequence before the hole's replay
   * or its explicit gap notice.
   */
  private startOrderedDrain(sessionId: string, signal: AbortSignal): void {
    const delivery = this.orderedDeliveries.get(sessionId)
    if (delivery === undefined) return
    // A reconnect can deliver a new frame while the previous generation is
    // unwinding. Remember that newer signal even when the old drain still owns
    // the turn, so its finally block can hand the queue to the live generation.
    delivery.drainSignal = signal
    if (delivery.draining) return
    delivery.draining = true
    void this.drainOrderedSession(sessionId, delivery, signal)
      .catch(() => undefined)
      .finally(() => {
        if (this.orderedDeliveries.get(sessionId) !== delivery) return
        delivery.draining = false
        const nextSignal = delivery.drainSignal
        if (
          !this.closed &&
          nextSignal !== undefined &&
          !nextSignal.aborted &&
          (delivery.recoveryThrough !== undefined || delivery.pending.size > 0)
        )
          this.startOrderedDrain(sessionId, nextSignal)
      })
  }

  private async drainOrderedSession(
    sessionId: string,
    delivery: OrderedSessionDelivery,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !this.closed && this.orderedDeliveries.get(sessionId) === delivery) {
      const next = delivery.nextSequence
      const pending = delivery.pending.get(next)
      if (pending !== undefined && pending.length > 0) {
        this.emitPendingSequence(sessionId, delivery, next)
        continue
      }

      const requiredThrough = delivery.recoveryThrough
      if (requiredThrough !== undefined && requiredThrough >= next) {
        delete delivery.recoveryThrough
        await this.recoverOrderedRange(sessionId, delivery, next, requiredThrough, signal)
        continue
      }
      if (requiredThrough !== undefined) delete delivery.recoveryThrough

      const firstPending = smallestPendingSequence(delivery.pending, next)
      if (firstPending === undefined || firstPending <= next) return
      await this.recoverOrderedRange(sessionId, delivery, next, firstPending - 1, signal)
    }
  }

  private async recoverOrderedRange(
    sessionId: string,
    delivery: OrderedSessionDelivery,
    fromSequence: number,
    toSequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    let recovered: readonly BackendEvent[] = []
    if (this.recover !== undefined) {
      try {
        recovered = await this.recover(
          sessionId,
          fromSequence,
          toSequence,
          AbortSignal.any([signal, delivery.abort.signal]),
        )
      } catch {
        // A recovery read is advisory. The explicit gap below keeps the
        // ordered dispatcher moving while the Webview can retry from history.
      }
    }
    if (signal.aborted || this.closed || this.orderedDeliveries.get(sessionId) !== delivery) return

    for (const candidate of [...recovered].sort(
      (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
    )) {
      const sequence = candidate.sequence
      if (sequence === undefined || sequence < delivery.nextSequence || sequence > toSequence) continue
      if (
        candidate.type === 'session.projection' &&
        !this.rememberProjectionSequence(sessionId, candidate.key, sequence)
      ) {
        delivery.skippedSequences.add(sequence)
        continue
      }
      const pending = delivery.pending.get(sequence) ?? []
      if (pending.some((existing) => sameBackendEvent(existing, candidate))) continue
      pending.push(candidate)
      delivery.pending.set(sequence, pending)
    }

    while (
      delivery.nextSequence <= toSequence &&
      !signal.aborted &&
      !this.closed &&
      this.orderedDeliveries.get(sessionId) === delivery
    ) {
      const next = delivery.nextSequence
      const pending = delivery.pending.get(next)
      if (pending !== undefined && pending.length > 0) {
        delivery.skippedSequences.delete(next)
        this.emitPendingSequence(sessionId, delivery, next)
        continue
      }
      if (delivery.skippedSequences.delete(next)) {
        delivery.nextSequence = next + 1
        continue
      }
      const nextPresent = smallestPendingSequence(delivery.pending, next + 1, toSequence)
      const nextSkipped = smallestSkippedSequence(delivery.skippedSequences, next + 1, toSequence)
      const firstPresent =
        nextPresent === undefined
          ? nextSkipped
          : nextSkipped === undefined
            ? nextPresent
            : Math.min(nextPresent, nextSkipped)
      const gapTo = firstPresent === undefined ? toSequence : firstPresent - 1
      this.emit({ type: 'session.gap', sessionId, fromSequence: next, toSequence: gapTo })
      delivery.nextSequence = gapTo + 1
    }
  }

  private rememberProjectionSequence(sessionId: string, key: string, sequence: number): boolean {
    const baseline = this.projectionBaselines.get(sessionId)
    if (baseline !== undefined && sequence <= baseline) return false
    const perSession = this.lastProjectionSequences.get(sessionId) ?? new Map<string, number>()
    const previous = perSession.get(key)
    if (previous !== undefined && sequence <= previous) return false
    perSession.set(key, sequence)
    this.lastProjectionSequences.set(sessionId, perSession)
    return true
  }

  private rememberProjectionBaseline(
    event: Extract<BackendEvent, { readonly type: 'session.subscribed' }>,
  ): void {
    const projection = event.projection
    if (projection === undefined) return
    const previousBaseline = this.projectionBaselines.get(event.sessionId)
    if (previousBaseline !== undefined && projection.asOfSequence <= previousBaseline) return
    this.projectionBaselines.set(event.sessionId, projection.asOfSequence)
    const perSession = this.lastProjectionSequences.get(event.sessionId) ?? new Map<string, number>()
    for (const key of Object.keys(projection.values)) {
      const previous = perSession.get(key)
      if (previous === undefined || projection.asOfSequence > previous)
        perSession.set(key, projection.asOfSequence)
    }
    this.lastProjectionSequences.set(event.sessionId, perSession)
  }

  private truncateProjectionSequences(sessionId: string, lastSequence: number): void {
    const perSession = this.lastProjectionSequences.get(sessionId)
    if (perSession === undefined) return
    for (const [key, sequence] of perSession) if (sequence > lastSequence) perSession.delete(key)
    if (perSession.size === 0) this.lastProjectionSequences.delete(sessionId)
  }

  /**
   * Commit one durable sequence before notifying consumers. Listener code can
   * synchronously close or restart the stream, so deleting and advancing only
   * after the callback would either duplicate the first record or strand the
   * remainder of a same-sequence bucket.
   */
  private emitPendingSequence(sessionId: string, delivery: OrderedSessionDelivery, sequence: number): void {
    const pending = delivery.pending.get(sequence)
    if (pending === undefined || pending.length === 0) return
    delivery.pending.delete(sequence)
    delivery.nextSequence = sequence + 1
    for (const event of pending) {
      if (this.closed || delivery.abort.signal.aborted || this.orderedDeliveries.get(sessionId) !== delivery)
        break
      this.emit(event)
    }
  }

  private replaceOrderedDelivery(sessionId: string, nextSequence: number): void {
    this.deleteOrderedDelivery(sessionId)
    this.orderedDeliveries.set(sessionId, createOrderedDelivery(nextSequence))
  }

  private deleteOrderedDelivery(sessionId: string): void {
    this.orderedDeliveries.get(sessionId)?.abort.abort()
    this.orderedDeliveries.delete(sessionId)
  }

  private clearOrderedDeliveries(): void {
    for (const delivery of this.orderedDeliveries.values()) delivery.abort.abort()
    this.orderedDeliveries.clear()
  }

  private emit(event: BackendEvent): void {
    // The observer owns cache/lifecycle side effects. Alpha may synchronously
    // close a session controller from there (for example after
    // `session.removed`), which clears this controller's live listener set.
    // Snapshot the listeners before invoking the observer so the event that
    // caused the teardown still reaches every subscriber exactly once.
    const listeners = [...this.listeners]
    try {
      this.observe?.(event)
    } catch {
      // Cache observers are advisory to delivery. One malformed projection or
      // repository-side invariant must not terminate the stream and discard
      // the rest of a same-sequence bucket.
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* isolate renderer listeners */
      }
    }
  }
}

function createOrderedDelivery(nextSequence: number): OrderedSessionDelivery {
  return {
    nextSequence,
    pending: new Map(),
    skippedSequences: new Set(),
    draining: false,
    abort: new AbortController(),
  }
}

function smallestPendingSequence(
  pending: ReadonlyMap<number, BackendEvent[]>,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  let smallest: number | undefined
  for (const sequence of pending.keys()) {
    if (sequence < minimum || sequence > maximum) continue
    if (smallest === undefined || sequence < smallest) smallest = sequence
  }
  return smallest
}

function smallestSkippedSequence(
  skipped: ReadonlySet<number>,
  minimum: number,
  maximum: number,
): number | undefined {
  let smallest: number | undefined
  for (const sequence of skipped) {
    if (sequence < minimum || sequence > maximum) continue
    if (smallest === undefined || sequence < smallest) smallest = sequence
  }
  return smallest
}

function sameBackendEvent(left: BackendEvent, right: BackendEvent): boolean {
  if (left === right) return true
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function normalizeEnvelope(value: unknown): BackendEvent | undefined {
  const envelope = record(value)
  const frame = record(envelope?.payload ?? value)
  if (frame === undefined)
    return withSequence({ type: 'unknown', name: 'protocol/frame', payload: safePayload(value) }, undefined)
  if (typeof frame.type !== 'string')
    return withSequence({ type: 'unknown', name: 'protocol/frame', payload: safePayload(frame) }, frame.seq)
  const withRpcId = typeof envelope?.rpcId === 'string' ? { ...frame, rpcId: envelope.rpcId } : frame
  switch (frame.type) {
    case 'session/assistant-stream':
      return normalizeAssistantStreamFrame(frame)
    case 'session/assistant-interrupted':
      return normalizeAssistantInterruptionFrame(frame)
    case 'session/event': {
      const event = record(frame.event)
      return typeof event?.type !== 'string'
        ? withSequence(
            {
              type: 'unknown',
              ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
              name: 'session/event',
              payload: safePayload(frame.event),
            },
            event?.seq,
          )
        : withSequence(
            mapStreamEvent(event.type, {
              ...event,
              sessionId: frame.sessionId,
              ...(frame.view === undefined ? {} : { view: frame.view }),
              ...(typeof envelope?.rpcId === 'string' ? { rpcId: envelope.rpcId } : {}),
            }),
            event.seq,
          )
    }
    case 'host/session-status':
    case 'host/session-activity':
    case 'host/session-added':
    case 'host/session-removed':
    case 'host/workspace-changed':
    case 'host/workspace-removed':
    case 'host/workspace-order-changed':
    case 'host/archived-sessions-changed':
    case 'host/commands-changed':
    case 'host/session-preset-changed':
    case 'host/settings-changed':
    case 'host/credentials-changed':
    case 'host/models-changed':
    case 'host/remote-event':
    case 'host/agent-error':
    case 'approval/requested':
    case 'approval/resolved':
    case 'question/requested':
    case 'question/resolved':
    case 'session/subscribed':
    case 'session/queue':
    case 'session/jobs':
    case 'session/tasks':
    case 'session/projection':
      return withSequence(mapStreamEvent(frame.type, withRpcId), frame.seq)
    case 'stream/error':
      return { type: 'connection.lost', reason: streamErrorReason(frame.error) }
    default:
      return withSequence(
        {
          type: 'unknown',
          ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
          name: frame.type,
          payload: safePayload(frame),
        },
        frame.seq,
      )
  }
}

function normalizeAssistantStreamFrame(value: Record<string, unknown>): BackendEvent | undefined {
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined
  const frame = record(value.frame)
  const chunk = record(frame?.chunk)
  if (
    sessionId === undefined ||
    frame === undefined ||
    frame.type !== 'chunk' ||
    chunk === undefined ||
    typeof frame.attemptId !== 'string' ||
    frame.attemptId.trim() === '' ||
    !safeNonNegativeInteger(frame.revision) ||
    !safeNonNegativeInteger(frame.index) ||
    !safeNonNegativeInteger(frame.turn) ||
    !safeNonNegativeInteger(frame.step) ||
    !safeInteger(frame.time) ||
    !safeNonNegativeInteger(value.transientSequence)
  )
    return undefined
  let startedAfterSeq: number | undefined
  if (frame.startedAfterSeq !== undefined) {
    if (!safeCursor(frame.startedAfterSeq)) return undefined
    startedAfterSeq = frame.startedAfterSeq
  }
  const chunkType = chunk.type
  if (chunkType !== 'text-delta' && chunkType !== 'reasoning-delta') return undefined
  if (typeof chunk.text !== 'string') return undefined
  const common = {
    sessionId,
    messageId: `assistant:${String(frame.turn)}:${String(frame.step)}`,
    delta: chunk.text,
    turn: frame.turn,
    step: frame.step,
    time: frame.time,
    transientSequence: value.transientSequence,
    transientAttemptId: frame.attemptId,
    transientIndex: frame.index,
    ...(startedAfterSeq === undefined ? {} : { transientStartedAfterSequence: startedAfterSeq }),
  }
  return chunkType === 'text-delta'
    ? { type: 'message.delta', ...common }
    : { type: 'reasoning.delta', ...common }
}

function normalizeAssistantInterruptionFrame(value: Record<string, unknown>): BackendEvent | undefined {
  const sessionId =
    typeof value.sessionId === 'string' && value.sessionId.trim() !== '' ? value.sessionId : undefined
  if (
    sessionId === undefined ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.trim() === '' ||
    !safeNonNegativeInteger(value.turn) ||
    !safeNonNegativeInteger(value.step)
  )
    return undefined
  return {
    type: 'message.completed',
    sessionId,
    messageId: `assistant:${String(value.turn)}:${String(value.step)}`,
    turn: value.turn,
    step: value.step,
    interrupted: true,
  }
}

function mapStreamEvent(name: string, value: unknown): BackendEvent {
  try {
    assertCanonicalSessionEvent(name, value)
    return rc6Mapper.event(name, value)
  } catch {
    const data = record(value)
    return {
      type: 'unknown',
      ...(typeof data?.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
      name,
      payload: safePayload(value),
    }
  }
}

function withSequence(event: BackendEvent, value: unknown): BackendEvent {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? { ...event, sequence: value }
    : event
}

function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if ('request' in event) return event.request.sessionId
  if ('question' in event) return event.question.sessionId
  if ('retry' in event) return event.retry.sessionId
  return undefined
}

function eventTransientSequence(event: BackendEvent): number | undefined {
  if (event.type !== 'message.delta' && event.type !== 'reasoning.delta') return undefined
  return event.transientSequence
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function safeCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= -1 && !Object.is(value, -0)
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)
}

function safeReason(error: unknown): string {
  if (error instanceof AppError) {
    const method = error.context?.method
    const status = error.context?.status
    if (typeof method === 'string' && typeof status === 'number')
      return `DSH event stream request ${method} failed (HTTP ${status}).`
    if (error.context?.timedOut === true && typeof method === 'string')
      return `DSH event stream request ${method} timed out.`
    return `DSH event stream disconnected (${error.code}).`
  }
  const detail = safeErrorDetail(error)
  return detail === undefined ? 'DSH event stream disconnected.' : `DSH event stream disconnected: ${detail}`
}

function streamErrorReason(value: unknown): string {
  const error = record(value)
  const code = typeof error?.code === 'string' ? error.code : undefined
  const message = safeErrorDetail(typeof error?.message === 'string' ? new Error(error.message) : undefined)
  if (code === undefined) return 'DSH event stream reported an unspecified error.'
  return message === undefined
    ? `DSH event stream reported ${code}.`
    : `DSH event stream reported ${code}: ${message}`
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const detail = redactText(error.message, 240)
  return detail === '' ? undefined : detail
}
