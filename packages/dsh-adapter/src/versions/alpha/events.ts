import type { AsyncEventSource, BackendEvent, JobView } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { DshStreamController, type StreamRecovery } from '../../stream-controller.js'
import type { AlphaLoopbackApiClient } from './transport.js'

/**
 * Alpha has one host-wide event stream plus independent durable Session and
 * Workspace projection streams. This class keeps those physical streams
 * behind the same AsyncEventSource consumed by the application layer.
 */
export class AlphaEventSource implements AsyncEventSource<BackendEvent> {
  private readonly global: DshStreamController
  private readonly workspace: DshStreamController
  private readonly sessionPreviews = new Map<string, boolean>()
  private readonly previewTransitions = new Set<string>()
  private readonly sessions = new Map<string, DshStreamController>()
  private readonly jobSessions = new Map<string, DshStreamController>()
  private readonly archivedSessions = new Set<string>()
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly subscriptions = new Map<
    DshStreamController,
    Map<(event: BackendEvent) => void, () => void>
  >()
  private readonly sessionFailureNotices = new Map<(event: BackendEvent) => void, Set<string>>()
  private closed = false

  public constructor(
    private readonly transport: AlphaLoopbackApiClient & DshTransport,
    private readonly observe?: (event: BackendEvent) => void,
    private readonly recover?: StreamRecovery,
    private readonly jobRows?: (sessionId: string, signal: AbortSignal) => AsyncIterable<unknown>,
    private readonly mapEvent: (event: BackendEvent) => BackendEvent = (event) => event,
    private readonly createSessionNormalizer?: () =>
      ((frame: unknown) => BackendEvent | undefined) | undefined,
  ) {
    this.global = new DshStreamController(transport, (event) => this.handleObserved(event, true), recover, {
      // The global controller shares the alpha transport with the workspace
      // and per-session controllers. The backend owns the one transport
      // lifecycle; a logical stream must not tear down its siblings.
      closeTransport: false,
    })
    this.workspace = new DshStreamController(transport, (event) => this.handleObserved(event), undefined, {
      streamSource: (signal) => transport.openWorkspaceStream(signal),
      closeTransport: false,
    })
  }

  public subscribe(listener: (event: BackendEvent) => void): () => void {
    if (this.closed) return () => undefined
    this.listeners.add(listener)
    for (const controller of this.controllers())
      this.attach(controller, listener, this.sessionIdFor(controller))
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      this.sessionFailureNotices.delete(listener)
      for (const entries of this.subscriptions.values()) entries.get(listener)?.()
      for (const entries of this.subscriptions.values()) entries.delete(listener)
    }
  }

  /**
   * Publish one settlement this client performed without a matching wire frame.
   *
   * An alpha Remote Event resolves the host waterfall for the client that
   * answers it, and the Gateway drops that client's delivery before it queues
   * the `cancel` frame, so the answering client never hears the request is
   * over. The acceptance is local knowledge (`$events/result` succeeded), so the
   * resolution is published here rather than fabricated as a transport frame.
   */
  public publish(event: BackendEvent): void {
    if (this.closed) return
    const listeners = [...this.listeners]
    const mapped = this.handleObserved(event, true)
    for (const listener of listeners) {
      try {
        listener(mapped)
      } catch {
        // One surface cannot prevent delivery to the remaining surfaces.
      }
    }
  }

  /** Start the durable follow stream for a Session the first time it is read. */
  public watchSession(sessionId: string): void {
    if (this.closed || sessionId.trim() === '' || this.archivedSessions.has(sessionId)) return
    // A partial unwatch (`keepJobRows`) left this session's Job stream alive.
    // Re-following must reuse it: replacing the map entry would strand the
    // still-subscribed controller and its listeners for the rest of the
    // connection instead of sharing one Job stream per session.
    if (this.jobRows !== undefined && !this.jobSessions.has(sessionId)) {
      const jobs = new DshStreamController(this.transport, (event) => this.handleObserved(event), undefined, {
        streamSource: (signal) => this.jobRows!(sessionId, signal),
        normalizeEvent: (frame) => normalizeJobRowsEvent(frame, sessionId),
        closeTransport: false,
      })
      this.jobSessions.set(sessionId, jobs)
      for (const listener of this.listeners) this.attach(jobs, listener, sessionId)
    }
    if (this.sessions.has(sessionId)) return
    const normalizeEvent = this.createSessionNormalizer?.()
    const controller = new DshStreamController(
      this.transport,
      (event) => this.handleObserved(event),
      this.recover,
      {
        streamSource: (signal) =>
          this.transport.openSessionStream(sessionId, signal, this.sessionPreviews.get(sessionId) ?? true),
        ...(normalizeEvent === undefined ? {} : { normalizeEvent }),
        closeTransport: false,
      },
    )
    this.sessions.set(sessionId, controller)
    for (const listener of this.listeners) this.attach(controller, listener, sessionId)
  }

  public setSessionPreview(sessionId: string, enabled: boolean): void {
    if (this.closed || this.sessionPreviews.get(sessionId) === enabled) return
    const wasEnabled = this.sessionPreviews.get(sessionId) ?? true
    this.sessionPreviews.set(sessionId, enabled)
    if (wasEnabled === enabled || !this.sessions.has(sessionId) || this.previewTransitions.has(sessionId))
      return
    this.previewTransitions.add(sessionId)
    queueMicrotask(() => {
      this.previewTransitions.delete(sessionId)
      if (!this.closed) void this.sessions.get(sessionId)?.restart()
    })
  }

  /** Re-baseline a watched session so process-local assistant chunks are replayed. */
  public async refreshSession(sessionId: string): Promise<void> {
    if (this.closed || sessionId.trim() === '' || this.archivedSessions.has(sessionId)) return
    this.watchSession(sessionId)
    await Promise.all([this.sessions.get(sessionId)?.restart(), this.jobSessions.get(sessionId)?.restart()])
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    const controllers = [...this.controllers()]
    await Promise.all(controllers.map((controller) => controller.close()))
    this.sessions.clear()
    this.sessionPreviews.clear()
    this.previewTransitions.clear()
    this.jobSessions.clear()
    this.archivedSessions.clear()
    this.sessionFailureNotices.clear()
    this.subscriptions.clear()
  }

  private controllers(): readonly DshStreamController[] {
    return [this.global, this.workspace, ...this.sessions.values(), ...this.jobSessions.values()]
  }

  private attach(
    controller: DshStreamController,
    listener: (event: BackendEvent) => void,
    sessionId: string | undefined,
  ): void {
    const entries = this.subscriptions.get(controller) ?? new Map<(event: BackendEvent) => void, () => void>()
    if (entries.has(listener)) return
    // A session-scoped follow stream failing is transport noise, not a backend
    // connection loss: the host-wide stream stays healthy and the session
    // controller runs its own recovery loop. Keep raw connection.lost scoped
    // out of session listeners, but emit one safe session-level notice so the
    // UI does not silently hide a live-stream interruption.
    const deliverRaw =
      sessionId !== undefined
        ? (event: BackendEvent): void => {
            if (event.type === 'connection.restored') return
            const failures = this.sessionFailureNotices.get(listener) ?? new Set<string>()
            this.sessionFailureNotices.set(listener, failures)
            if (event.type === 'connection.lost') {
              if (!failures.has(sessionId)) {
                failures.add(sessionId)
                listener({
                  type: 'notice',
                  sessionId,
                  level: 'warning',
                  text: 'The session live stream was interrupted; reconnecting.',
                })
              }
              return
            }
            if (event.type === 'session.subscribed') failures.delete(sessionId)
            listener(event)
          }
        : (event: BackendEvent): void => {
            // Only the host-wide controller owns connection health. A workspace
            // projection interruption must not invalidate live interaction ids.
            if (
              controller !== this.global &&
              (event.type === 'connection.lost' || event.type === 'connection.restored')
            )
              return
            listener(event)
          }
    entries.set(
      listener,
      controller.subscribe((event) => deliverRaw(this.mapEvent(event))),
    )
    this.subscriptions.set(controller, entries)
  }

  private handleObserved(event: BackendEvent, hostWide = false): BackendEvent {
    const mapped = this.mapEvent(event)
    // Controller observers run before listeners. Filter scoped health here as
    // well as in attach(), before repositories can invalidate live waterfalls.
    if (!hostWide && (mapped.type === 'connection.lost' || mapped.type === 'connection.restored'))
      return mapped
    try {
      this.observe?.(mapped)
    } catch {
      // Cache maintenance cannot suppress delivery or session-stream cleanup.
    }
    // Session follow streams are opened on demand: the application layer's
    // watch policy (panels, running work, pending interactions) decides which
    // sessions are followed. Eagerly following every `session.added` would
    // replay each session's full history on connect and starve the transport
    // heartbeat in workspaces with many sessions.
    if (mapped.type === 'archived.sessions.changed') {
      this.archivedSessions.clear()
      for (const sessionId of mapped.sessionIds) this.archivedSessions.add(sessionId)
      for (const sessionId of new Set([...this.sessions.keys(), ...this.jobSessions.keys()]))
        if (this.archivedSessions.has(sessionId)) this.unwatchSession(sessionId)
    }
    // Symmetric lifecycle: a session the host removed must not keep a follow
    // stream. Its server stream is gone, so the abandoned controller would
    // reconnect (and report connection losses) forever against a session that
    // no longer exists. SessionRepository.get() re-watches on later access.
    if (mapped.type === 'session.removed') {
      this.archivedSessions.delete(mapped.sessionId)
      this.unwatchSession(mapped.sessionId)
    }
    return mapped
  }

  private sessionIdFor(controller: DshStreamController): string | undefined {
    for (const [sessionId, candidate] of this.sessions) if (candidate === controller) return sessionId
    for (const [sessionId, candidate] of this.jobSessions) if (candidate === controller) return sessionId
    return undefined
  }

  /**
   * Stop following a session. The application layer owns the lifecycle policy
   * (display, running work, pending interactions); `keepJobRows` releases only
   * the conversation follow stream while background jobs are still running.
   */
  public unwatchSession(sessionId: string, options: { readonly keepJobRows?: boolean } = {}): void {
    if (this.closed) return
    void this.closeSessionStreams(sessionId, options)
  }

  private async closeSessionStreams(
    sessionId: string,
    options: { readonly keepJobRows?: boolean },
  ): Promise<void> {
    this.clearSessionFailureNotices(sessionId)
    this.sessionPreviews.delete(sessionId)
    this.previewTransitions.delete(sessionId)
    const controller = this.sessions.get(sessionId)
    if (controller !== undefined) {
      this.sessions.delete(sessionId)
      this.subscriptions.delete(controller)
    }
    if (options.keepJobRows !== true) {
      const jobs = this.jobSessions.get(sessionId)
      if (jobs !== undefined) {
        this.jobSessions.delete(sessionId)
        this.subscriptions.delete(jobs)
        await Promise.all([controller?.close(), jobs.close()])
        return
      }
    }
    await controller?.close()
  }

  private clearSessionFailureNotices(sessionId: string): void {
    for (const failures of this.sessionFailureNotices.values()) failures.delete(sessionId)
  }
}

function normalizeJobRowsEvent(value: unknown, sessionId: string): BackendEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'jobs.updated' || record.sessionId !== sessionId || !Array.isArray(record.jobs))
    return undefined
  return {
    type: 'jobs.updated',
    sessionId,
    // The alpha171 repository performs strict wire validation before yielding
    // this internal typed frame; unlike legacy `session/jobs`, this new Remote
    // carries progress and safe output offsets that the mapper must preserve.
    jobs: record.jobs as readonly JobView[],
  }
}
