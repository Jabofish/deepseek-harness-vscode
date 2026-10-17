import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

export class BackendService {
  /** Re-deliver current DSH control facts after a Webview transport invalidation. */
  public replayEvents(): readonly BackendEvent[] {
    return [...this.replay.values()]
  }
  private backend: DshBackend | undefined
  private unsubscribe: (() => void) | undefined
  private readonly replay = new Map<string, BackendEvent>()
  private generation = 0

  public attach(backend: DshBackend, onEvent: (event: BackendEvent) => void): void {
    const generation = ++this.generation
    if (this.backend !== backend) this.replay.clear()
    const previousUnsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    previousUnsubscribe?.()
    // Connection ownership belongs to DshConnectionCoordinator.  Closing the
    // previous backend here races a concurrent attach and made one logical
    // connection have two independent owners.  This service only binds the
    // application event sink; the coordinator closes the backend and any
    // managed process exactly once during disconnect.
    this.backend = backend
    const replay = [...this.replay.values()]
    const opening: BackendEvent[] = []
    let buffering = true
    const unsubscribe = backend.events.subscribe((event) => {
      if (this.generation !== generation) return
      this.remember(event)
      if (buffering) opening.push(event)
      else onEvent(event)
    })
    if (this.generation !== generation) {
      unsubscribe()
      return
    }
    this.unsubscribe = unsubscribe
    // Some event sources deliver their opening snapshot inside subscribe.
    // Replay the preceding cache, then those new events, each exactly once.
    for (const event of replay) {
      if (this.generation !== generation) return
      onEvent(event)
    }
    for (let index = 0; index < opening.length; index += 1) {
      if (this.generation !== generation) return
      onEvent(opening[index]!)
    }
    buffering = false
  }

  public requireBackend(): DshBackend {
    if (this.backend !== undefined) return this.backend
    throw new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'Connect to a local DSH instance first.',
      retryable: true,
    })
  }

  public detach(): Promise<void> {
    this.generation += 1
    const unsubscribe = this.unsubscribe
    const backend = this.backend
    this.unsubscribe = undefined
    this.backend = undefined
    this.replay.clear()
    unsubscribe?.()
    // Do not close the backend here.  The coordinator owns its lifetime and
    // may be in the middle of a serialized disconnect/replace operation.
    void backend
    return Promise.resolve()
  }

  private remember(event: BackendEvent): void {
    if (event.type === 'session.removed') {
      for (const [key, remembered] of this.replay) {
        if (remembered.type === 'session.projection.baseline') {
          const projections = { ...remembered.projections }
          delete projections[event.sessionId]
          this.replay.set(key, { ...remembered, projections })
        } else if (eventSessionId(remembered) === event.sessionId) this.replay.delete(key)
      }
      return
    }
    if (event.type === 'session.projection.baseline') {
      // Whole-set replacement retires every preceding delta, including those
      // for sessions absent from this baseline. Otherwise replay resurrects
      // removed sessions, which no longer have a sequence watermark.
      for (const [key, remembered] of this.replay) {
        if (remembered.type === 'session.projection' || remembered.type === 'session.projection.baseline')
          this.replay.delete(key)
      }
    }
    // Resolutions carry no replay key of their own; they are remembered by
    // retiring the interaction they settle. The Webview re-renders whatever
    // this cache replays, and a settled approval or question can no longer be
    // answered, so leaving one here shows a dead prompt after every reload.
    if (event.type === 'permission.resolved') {
      this.replay.delete(`permission:${event.sessionId}:${event.requestId}`)
      return
    }
    if (event.type === 'question.resolved') {
      // DSH holds every unanswered question pending at once (the upstream
      // provider keys them by rpc id), so one resolution retires only the
      // question it names. A resolution that names none of them is the sole
      // case that may sweep the session.
      for (const [key, remembered] of this.replay) {
        if (remembered.type !== 'question.requested') continue
        if (remembered.question.sessionId !== event.sessionId) continue
        if (
          event.questionRpcId !== undefined
            ? remembered.question.rpcId === event.questionRpcId
            : event.questionId === undefined || remembered.question.id === event.questionId
        )
          this.replay.delete(key)
      }
      return
    }
    const key = replayKey(event)
    if (key === undefined) return
    const previous = this.replay.get(key)
    this.replay.set(
      key,
      event.type === 'session.configuration' && previous?.type === 'session.configuration'
        ? {
            ...event,
            patch: {
              ...previous.patch,
              ...event.patch,
              ...(event.patch.model === undefined
                ? {}
                : { model: { ...previous.patch.model, ...event.patch.model } }),
            },
          }
        : event,
    )
    this.evictToBound()
  }

  /**
   * Keep the replay cache bounded without retiring a prompt the Host still owes
   * an answer for. Insertion order alone is the wrong key: a working session
   * publishes status and projections continuously, so a blind FIFO drops a
   * pending approval or question after a few hundred events and the panel comes
   * back from a reload with no card to answer -- the agent stays blocked on an
   * answer the user can no longer see. Settled interactions and streamed state
   * are the disposable entries, so they go first.
   *
   * Prompts are only *preferred*, not immune: a fan-out agent can hold more
   * questions pending at once than the bound allows. If the first pass leaves
   * the cache over budget because every remaining entry is a prompt, a second
   * pass evicts in insertion order anyway. Yielding unconditionally would let
   * the "bound" stop bounding exactly in the case it was written for, and every
   * reload would then re-post the whole backlog.
   */
  private evictToBound(): void {
    if (this.replay.size <= REPLAY_BOUND) return
    for (const [key, event] of this.replay) {
      if (this.replay.size <= REPLAY_BOUND) return
      if (isPendingPrompt(event) || event.type === 'session.projection.baseline') continue
      this.replay.delete(key)
    }
    // Pending prompts may overflow, but the single baseline is indispensable:
    // joining the existing control stream cannot request it again.
    for (const [key, event] of this.replay) {
      if (this.replay.size <= REPLAY_BOUND) return
      if (event.type === 'session.projection.baseline') continue
      this.replay.delete(key)
    }
  }
}

function eventSessionId(event: BackendEvent): string | undefined {
  if (event.type === 'permission.requested') return event.request.sessionId
  if (event.type === 'question.requested') return event.question.sessionId
  return 'sessionId' in event ? event.sessionId : undefined
}

const REPLAY_BOUND = 256

/** An interaction the Host is still waiting to settle, so it must stay replayable. */
function isPendingPrompt(event: BackendEvent): boolean {
  return event.type === 'permission.requested' || event.type === 'question.requested'
}

function replayKey(event: BackendEvent): string | undefined {
  switch (event.type) {
    // A single fixed key, not a per-session one: the baseline replaces the
    // whole projection set, so only the newest is worth replaying. Keeping the
    // older ones would let a reloaded panel re-apply a stale waterline after
    // the newer one.
    case 'session.projection.baseline':
      return 'projection.baseline'
    case 'permission.requested':
      return `permission:${event.request.sessionId}:${event.request.id}`
    case 'question.requested':
      return `question:${event.question.sessionId}:${event.question.id}`
    case 'queue.updated':
    case 'goal.updated':
    case 'todo.updated':
    case 'jobs.updated':
    case 'session.subscribed':
    case 'session.projection':
    case 'session.configuration':
    case 'compaction.updated':
      return `${event.type}:${event.sessionId}:${'key' in event ? event.key : ''}`
    case 'session.status':
      return `status:${event.sessionId}`
    default:
      return undefined
  }
}
