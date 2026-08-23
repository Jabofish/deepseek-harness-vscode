import { AppError, type AsyncEventSource, type BackendEvent } from '@dsh-vscode/domain'

import type { DshTransport } from './contracts.js'
import { redactText, safePayload } from './redaction.js'
import { rc6Mapper } from './versions/rc6/mapper.js'

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
  /** Projection frames share the durable event sequence, so dedupe them per key. */
  private readonly lastProjectionSequences = new Map<string, Map<string, number>>()
  private lifetime: AbortController | undefined
  private reading: Promise<void> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryAttempt = 0
  private closed = false

  public constructor(
    private readonly transport: DshTransport,
    private readonly observe?: (event: BackendEvent) => void,
    private readonly recover?: StreamRecovery,
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
    await this.transport.close()
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
    const tasks: Promise<void>[] = [
      Promise.resolve().then(() =>
        this.readStream(
          this.transport.openMuxStream?.(signal) ?? this.transport.openEventStream(signal),
          signal,
        ),
      ),
    ]
    if (this.transport.openHostStream !== undefined)
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
    try {
      for await (const envelope of stream) {
        if (this.closed || signal.aborted) return
        const event = normalizeEnvelope(envelope)
        if (event !== undefined) await this.accept(event, signal)
      }
      if (!this.closed && !signal.aborted) throw new Error('DSH event stream ended.')
    } catch (error) {
      if (!this.closed && !signal.aborted) throw error
    }
  }

  private async accept(event: BackendEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    if (event.type === 'session.removed') {
      this.lastSequences.delete(event.sessionId)
      this.lastProjectionSequences.delete(event.sessionId)
    }
    if (event.type === 'session.subscribed') {
      this.truncateProjectionSequences(event.sessionId, event.lastSequence)
      const previous = this.lastSequences.get(event.sessionId)
      if (previous === undefined) {
        this.lastSequences.set(event.sessionId, event.lastSequence)
      } else if (event.lastSequence > previous) {
        const afterRecovery = await this.recoverRange(
          event.sessionId,
          previous + 1,
          event.lastSequence,
          signal,
        )
        if (signal.aborted) return
        if (afterRecovery + 1 < event.lastSequence)
          this.emit({
            type: 'session.gap',
            sessionId: event.sessionId,
            fromSequence: afterRecovery + 1,
            toSequence: event.lastSequence,
          })
      }
      this.retryAttempt = 0
      this.emit(event)
      return
    }
    const sessionId = eventSessionId(event)
    const sequence = event.sequence
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
    if (sequence > previous + 1 && this.recover !== undefined) {
      const afterRecovery = await this.recoverRange(sessionId, previous + 1, sequence - 1, signal)
      if (signal.aborted) return
      if (afterRecovery + 1 < sequence)
        this.emit({
          type: 'session.gap',
          sessionId,
          fromSequence: afterRecovery + 1,
          toSequence: sequence - 1,
        })
    } else if (sequence > previous + 1) {
      this.emit({
        type: 'session.gap',
        sessionId,
        fromSequence: previous + 1,
        toSequence: sequence - 1,
      })
    }
    this.lastSequences.set(sessionId, sequence)
    this.retryAttempt = 0
    this.emit(event)
  }

  private truncateProjectionSequences(sessionId: string, lastSequence: number): void {
    const perSession = this.lastProjectionSequences.get(sessionId)
    if (perSession === undefined) return
    for (const [key, sequence] of perSession) if (sequence > lastSequence) perSession.delete(key)
    if (perSession.size === 0) this.lastProjectionSequences.delete(sessionId)
  }

  private async recoverRange(
    sessionId: string,
    fromSequence: number,
    toSequence: number,
    signal: AbortSignal,
  ): Promise<number> {
    let cursor = this.lastSequences.get(sessionId) ?? fromSequence - 1
    if (this.recover === undefined || fromSequence > toSequence) return cursor
    try {
      const recovered = await this.recover(sessionId, fromSequence, toSequence, signal)
      for (const candidate of [...recovered].sort(
        (left, right) => (left.sequence ?? 0) - (right.sequence ?? 0),
      )) {
        if (signal.aborted) return cursor
        const recoveredSequence = candidate.sequence
        if (recoveredSequence === undefined || recoveredSequence <= cursor) continue
        if (recoveredSequence > cursor + 1)
          this.emit({
            type: 'session.gap',
            sessionId,
            fromSequence: cursor + 1,
            toSequence: recoveredSequence - 1,
          })
        cursor = recoveredSequence
        this.lastSequences.set(sessionId, cursor)
        this.emit(candidate)
      }
    } catch {
      // A recovery read is advisory. The caller emits an explicit gap so
      // projection consumers cannot mistake an incomplete replay for a
      // contiguous stream.
    }
    return cursor
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
    case 'host/session-added':
    case 'host/session-removed':
    case 'host/workspace-changed':
    case 'host/workspace-removed':
    case 'host/workspace-order-changed':
    case 'host/archived-sessions-changed':
    case 'host/remote-event':
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
    case 'host/agent-error':
      return {
        type: 'notice',
        ...(typeof frame.sessionId === 'string' ? { sessionId: frame.sessionId } : {}),
        level: 'error',
        text: typeof frame.message === 'string' ? frame.message.slice(0, 512) : 'DSH agent error.',
      }
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

function mapStreamEvent(name: string, value: unknown): BackendEvent {
  try {
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
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
