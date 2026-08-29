import type { AsyncEventSource, BackendEvent } from '@dsh-vscode/domain'

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
  private readonly sessions = new Map<string, DshStreamController>()
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly subscriptions = new Map<
    DshStreamController,
    Map<(event: BackendEvent) => void, () => void>
  >()
  private closed = false

  public constructor(
    private readonly transport: AlphaLoopbackApiClient & DshTransport,
    private readonly observe?: (event: BackendEvent) => void,
    private readonly recover?: StreamRecovery,
  ) {
    this.global = new DshStreamController(transport, (event) => this.handleObserved(event), recover, {
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
    for (const controller of this.controllers()) this.attach(controller, listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.listeners.delete(listener)
      for (const entries of this.subscriptions.values()) entries.get(listener)?.()
      for (const entries of this.subscriptions.values()) entries.delete(listener)
    }
  }

  /** Start the durable follow stream for a Session the first time it is read. */
  public watchSession(sessionId: string): void {
    if (this.closed || sessionId.trim() === '' || this.sessions.has(sessionId)) return
    const controller = new DshStreamController(
      this.transport,
      (event) => this.handleObserved(event),
      this.recover,
      {
        streamSource: (signal) => this.transport.openSessionStream(sessionId, signal),
        closeTransport: false,
      },
    )
    this.sessions.set(sessionId, controller)
    for (const listener of this.listeners) this.attach(controller, listener)
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    const controllers = [...this.controllers()]
    await Promise.all(controllers.map((controller) => controller.close()))
    this.sessions.clear()
    this.subscriptions.clear()
  }

  private controllers(): readonly DshStreamController[] {
    return [this.global, this.workspace, ...this.sessions.values()]
  }

  private attach(controller: DshStreamController, listener: (event: BackendEvent) => void): void {
    const entries = this.subscriptions.get(controller) ?? new Map<(event: BackendEvent) => void, () => void>()
    if (entries.has(listener)) return
    entries.set(listener, controller.subscribe(listener))
    this.subscriptions.set(controller, entries)
  }

  private handleObserved(event: BackendEvent): void {
    this.observe?.(event)
    // Existing sessions are lazily watched by SessionRepository.get(). A new
    // session announced by the host must also become live immediately so its
    // durable events are not missed between list refreshes.
    if (event.type === 'session.added') this.watchSession(event.sessionId)
  }
}
