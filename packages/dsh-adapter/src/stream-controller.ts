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

/** One shared mux/host reader for every consumer in an Extension Host. */
export class DshStreamController implements AsyncEventSource<BackendEvent> {
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly lastSequences = new Map<string, number>()
  /** Alpha session/follow sends its history snapshot before this baseline. */
  private readonly subscribedSessions = new Set<string>()
  /** Projection frames share the durable event sequence, so dedupe them per key. */
  private readonly lastProjectionSequences = new Map<string, Map<string, number>>()
  /** Alpha13 transient frames have a separate local sequence space. */
  private readonly lastTransientSequences = new Map<string, number>()
  /** One detached history recovery at a time per session, in detection order. */
  private readonly recoveries = new Map<string, Promise<void>>()
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
      this.lastProjectionSequences.clear()
      this.lastTransientSequences.clear()
      this.subscribedSessions.clear()
      this.recoveries.clear()
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
      this.lastProjectionSequences.delete(event.sessionId)
      this.lastTransientSequences.delete(event.sessionId)
      this.subscribedSessions.delete(event.sessionId)
    }
    if (event.type === 'session.subscribed') {
      this.subscribedSessions.add(event.sessionId)
      this.lastTransientSequences.delete(event.sessionId)
      this.truncateProjectionSequences(event.sessionId, event.lastSequence)
      const previous = this.lastSequences.get(event.sessionId)
      if (previous === undefined) {
        this.lastSequences.set(event.sessionId, event.lastSequence)
      } else if (event.lastSequence > previous) {
        // The v1 mux has no client-side resume hook ("since" is ignored), so a
        // re-subscribe above the cached watermark means the missed range is
        // only reachable through history. Recover off the read loop: blocking
        // here suspends the follow consumer while the host keeps streaming,
        // which used to overflow the receive queue and kill the stream
        // mid-answer.
        this.scheduleRecovery(event.sessionId, previous + 1, event.lastSequence, signal)
      } else if (event.lastSequence < previous) {
        // The v1 mux has no client-side resume hook ("since" is ignored), so
        // the host's subscribed frame is the authoritative log baseline. A
        // lower value means the host log no longer contains what this cache
        // holds; keeping the stale watermark would silently drop the host's
        // new event epoch below it. Follow the baseline down instead.
        this.lastSequences.set(event.sessionId, event.lastSequence)
      }
      this.retryAttempt = 0
      this.emit(event)
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
      const perSession = this.lastProjectionSequences.get(sessionId) ?? new Map<string, number>()
      const previous = perSession.get(event.key)
      if (previous !== undefined && sequence <= previous) return
      perSession.set(event.key, sequence)
      this.lastProjectionSequences.set(sessionId, perSession)
      this.emit(event)
      return
    }
    const previous = this.lastSequences.get(sessionId) ?? -1
    if (sequence <= previous) return
    if (this.options.streamSource !== undefined && !this.subscribedSessions.has(sessionId)) {
      // A session/follow snapshot is a bounded history sample and is emitted
      // before its session/subscribed cursor. A sample can legitimately start
      // above sequence zero; do not manufacture a gap until the live baseline
      // has been established.
      this.lastSequences.set(sessionId, sequence)
      this.emit(event)
      return
    }
    if (sequence > previous + 1) this.scheduleRecovery(sessionId, previous + 1, sequence - 1, signal)
    this.lastSequences.set(sessionId, sequence)
    this.retryAttempt = 0
    this.emit(event)
  }

  /**
   * Heal a detected sequence hole without suspending the read loop. The
   * current event is delivered immediately and the history replay for the
   * hole runs detached; consumers observe the recovered events (below the
   * watermark) plus a `session.gap` for whatever history could not cover.
   */
  private scheduleRecovery(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
    signal: AbortSignal,
  ): void {
    if (fromSequence > toSequence) return
    if (this.recover === undefined) {
      this.emit({
        type: 'session.gap',
        sessionId,
        fromSequence,
        toSequence,
      })
      return
    }
    const previousTail = this.recoveries.get(sessionId)
    const task = (async () => {
      try {
        await previousTail
      } catch {
        /* the queued predecessor already announced its own gap */
      }
      if (signal.aborted || this.closed) return
      await this.recoverRange(sessionId, fromSequence, toSequence, signal)
    })()
    const tail = task.finally(() => {
      if (this.recoveries.get(sessionId) === tail) this.recoveries.delete(sessionId)
    })
    this.recoveries.set(sessionId, tail)
  }

  private truncateProjectionSequences(sessionId: string, lastSequence: number): void {
    const perSession = this.lastProjectionSequences.get(sessionId)
    if (perSession === undefined) return
    for (const [key, sequence] of perSession) if (sequence > lastSequence) perSession.delete(key)
    if (perSession.size === 0) this.lastProjectionSequences.delete(sessionId)
  }

  /**
   * Replay one sequence hole from history. Runs detached from the read loop,
   * so it must not touch `lastSequences`: the watermark already moved past the
   * hole when the hole was detected. Recovered events are emitted below the
   * watermark (consumers dedupe by sequence), and whatever history could not
   * cover is announced as `session.gap` so consumers can heal it themselves.
   */
  private async recoverRange(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.recover === undefined || fromSequence > toSequence) return
    let cursor = fromSequence - 1
    try {
      const recovered = await this.recover(sessionId, fromSequence, toSequence, signal)
      for (const candidate of [...recovered].sort(
        (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
      )) {
        if (signal.aborted) break
        const recoveredSequence = candidate.sequence
        if (recoveredSequence === undefined || recoveredSequence <= cursor) continue
        if (recoveredSequence > toSequence) break
        if (recoveredSequence > cursor + 1)
          this.emit({
            type: 'session.gap',
            sessionId,
            fromSequence: cursor + 1,
            toSequence: recoveredSequence - 1,
          })
        cursor = recoveredSequence
        this.emit(candidate)
      }
    } catch {
      // A recovery read is advisory. The explicit gap below keeps projection
      // consumers from mistaking an incomplete replay for a contiguous stream.
    }
    if (!signal.aborted && cursor < toSequence)
      this.emit({
        type: 'session.gap',
        sessionId,
        fromSequence: cursor + 1,
        toSequence,
      })
  }

  private emit(event: BackendEvent): void {
    this.observe?.(event)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* isolate renderer listeners */
      }
    }
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
    case 'host/remote-event':
    case 'host/agent-error':
    case 'approval/requested':
    case 'approval/resolved':
    case 'question/requested':
    case 'question/resolved':
    case 'session/subscribed':
    case 'session/queue':
    case 'session/jobs':
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
