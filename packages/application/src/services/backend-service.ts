import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'
import { AppError, QuestionSettlements, matchesQuestionResolution } from '@dsh-vscode/domain'

export class BackendService {
  /** Re-deliver current DSH control facts after a Webview transport invalidation. */
  public replayEvents(): readonly BackendEvent[] {
    const replay = [...this.replay.values()]
    const terminal = new Map<string, BackendEvent>()
    const overlay = (sessionId: string, value: unknown): void => {
      if (typeof value !== 'object' || value === null || !('active' in value) || !Array.isArray(value.active))
        return
      for (const candidate of value.active as readonly unknown[]) {
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          !('callId' in candidate) ||
          typeof candidate.callId !== 'string' ||
          !this.questionSettlements.hasCall(sessionId, candidate.callId)
        )
          continue
        terminal.set(JSON.stringify([sessionId, candidate.callId]), {
          type: 'question.reply.status',
          sessionId,
          callId: candidate.callId,
          state: 'settled',
          asOfSequence: -1,
        })
      }
    }
    for (const event of replay) {
      if (event.type === 'session.projection' && event.key === 'userQuestions')
        overlay(event.sessionId, event.value)
      if (event.type === 'session.subscribed' && event.projection !== undefined)
        overlay(event.sessionId, event.projection.values.userQuestions)
      if (event.type === 'session.projection.baseline')
        for (const [sessionId, projection] of Object.entries(event.projections))
          overlay(sessionId, projection.values.userQuestions)
    }
    return [...replay, ...terminal.values()]
  }
  private backend: DshBackend | undefined
  private unsubscribe: (() => void) | undefined
  private readonly replay = new Map<string, BackendEvent>()
  private generation = 0
  private readonly questionSettlements = new QuestionSettlements()

  public attach(backend: DshBackend, onEvent: (event: BackendEvent) => void): void {
    const generation = ++this.generation
    if (this.backend !== backend) {
      this.replay.clear()
      this.questionSettlements.clear()
    }
    const previousUnsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    previousUnsubscribe?.()
    // Connection ownership belongs to DshConnectionCoordinator.  Closing the
    // previous backend here races a concurrent attach and made one logical
    // connection have two independent owners.  This service only binds the
    // application event sink; the coordinator closes the backend and any
    // managed process exactly once during disconnect.
    this.backend = backend
    const replay = this.replayEvents()
    const opening: BackendEvent[] = []
    let buffering = true
    const unsubscribe = backend.events.subscribe((event) => {
      if (this.generation !== generation) return
      if (event.type === 'question.requested' && this.questionSettlements.has(event.question)) return
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
    this.questionSettlements.clear()
    unsubscribe?.()
    // Do not close the backend here.  The coordinator owns its lifetime and
    // may be in the middle of a serialized disconnect/replace operation.
    void backend
    return Promise.resolve()
  }

  private remember(event: BackendEvent): void {
    if (event.type === 'question.reply.status' && (event.state === 'admitted' || event.state === 'settled')) {
      this.questionSettlements.acceptCall(event.sessionId, event.callId)
      for (const [key, remembered] of this.replay)
        if (remembered.type === 'question.requested' && this.questionSettlements.has(remembered.question))
          this.replay.delete(key)
    }
    if (event.type === 'connection.lost') {
      for (const [key, remembered] of this.replay)
        if (remembered.type === 'question.requested') this.replay.delete(key)
      return
    }
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
      this.questionSettlements.resolve(
        event,
        [...this.replay.values()].flatMap((remembered) =>
          remembered.type === 'question.requested' ? [remembered.question] : [],
        ),
      )
      // DSH holds every unanswered question pending at once (the upstream
      // provider keys them by rpc id), so one resolution retires only the
      // question it names. A resolution that names none of them is the sole
      // case that may sweep the session.
      for (const [key, remembered] of this.replay) {
        if (remembered.type !== 'question.requested') continue
        if (remembered.question.sessionId !== event.sessionId) continue
        if (
          matchesQuestionResolution(remembered.question, event) ||
          (event.questionRpcId === undefined && event.questionId === undefined)
        )
          this.replay.delete(key)
      }
      return
    }
    if (event.type === 'session.projection' && event.key === 'userQuestions')
      this.questionSettlements.project(event.sessionId, event.value)
    if (event.type === 'session.subscribed' && event.projection !== undefined)
      this.questionSettlements.project(event.sessionId, event.projection.values.userQuestions)
    if (event.type === 'session.projection.baseline')
      for (const [sessionId, projection] of Object.entries(event.projections))
        this.questionSettlements.project(sessionId, projection.values.userQuestions)
    if (
      (event.type === 'session.projection' && event.key === 'userQuestions') ||
      event.type === 'session.subscribed' ||
      event.type === 'session.projection.baseline'
    )
      for (const [key, remembered] of this.replay)
        if (remembered.type === 'question.requested' && this.questionSettlements.has(remembered.question))
          this.replay.delete(key)
    const key = replayKey(event)
    if (key === undefined) return
    const previous = this.replay.get(key)
    if (
      event.type === 'question.reply.status' &&
      previous?.type === 'question.reply.status' &&
      event.asOfSequence < previous.asOfSequence
    )
      return
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
  return (
    event.type === 'permission.requested' ||
    event.type === 'question.requested' ||
    (event.type === 'question.reply.status' && (event.state === 'queued' || event.state === 'claimed'))
  )
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
      return JSON.stringify([
        'question',
        event.question.sessionId,
        event.question.rpcId ?? event.question.callId ?? event.question.id,
      ])
    case 'question.reply.status':
      return JSON.stringify(['question.reply', event.sessionId, event.callId])
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
