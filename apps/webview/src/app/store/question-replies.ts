import type { BackendEvent, QuestionSettlements } from '@dsh-vscode/domain'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from '../protocol-client.js'
import { queuedQuestionReplyCallIds } from '../timed-question-projections.js'
import type { AppState, StateSetter } from './types.js'
import { object } from './unknown-record.js'
import { requestId } from './ids.js'

export const questionReplyKey = (sessionId: string, callId: string): string =>
  JSON.stringify([sessionId, callId])

interface Reply {
  readonly sessionId: string
  readonly callId: string
  readonly epoch: number | undefined
  /** Cut read from the server after this answer was accepted. */
  receiptSequence: number | undefined
  reading: boolean
  seenQueued: boolean
  accepted: boolean
}

/** The Remote receipt means queued, not settled. Own this latch outside cards. */
export class QuestionReplies {
  private readonly replies = new Map<string, Reply>()
  private readonly statuses = new Map<string, Extract<BackendEvent, { type: 'question.reply.status' }>>()
  private statusSnapshot: NonNullable<AppState['questionReplyStates']> = {}
  private projection: AppState['projections'] | undefined
  private epoch: number | undefined
  private settled: readonly string[] | undefined
  private revision = 0
  private observedRevision = -1
  private keys: readonly string[] = []
  public constructor(
    private readonly client: ProtocolClient,
    private readonly getState: () => AppState,
    private readonly setState: StateSetter,
    private readonly settlements: QuestionSettlements,
    private readonly inboxSequence: (sessionId: string) => number | undefined = () => undefined,
  ) {}

  public clear(): void {
    this.replies.clear()
    this.statuses.clear()
    this.statusSnapshot = {}
    this.revision++
  }

  public observe(event: BackendEvent): void {
    if (event.type !== 'question.reply.status') return
    // An accepted reply is terminal even when a reread overlays an older
    // projection cut; terminal call identities cannot become answerable again.
    if (event.state === 'admitted' || event.state === 'settled')
      this.settlements.acceptCall(event.sessionId, event.callId)
    const key = questionReplyKey(event.sessionId, event.callId)
    const previous = this.statuses.get(key)
    if (
      previous !== undefined &&
      (event.asOfSequence < previous.asOfSequence ||
        (event.asOfSequence === previous.asOfSequence && event.state === previous.state))
    )
      return
    this.statuses.set(key, event)
    while (this.statuses.size > 4096) this.statuses.delete(this.statuses.keys().next().value!)
    this.statusSnapshot = Object.fromEntries([...this.statuses].map(([id, value]) => [id, value.state]))
    const receiptSequence = this.replies.get(key)?.receiptSequence
    if (
      (event.state === 'released' && receiptSequence !== undefined && event.asOfSequence > receiptSequence) ||
      event.state === 'admitted' ||
      event.state === 'settled'
    )
      this.replies.delete(key)
    this.revision++
  }

  public reconcile(state: AppState): AppState {
    const settled = this.settlements.settledCalls()
    if (
      this.projection !== state.projections ||
      this.epoch !== state.connectionEpoch ||
      this.settled !== settled ||
      this.observedRevision !== this.revision
    ) {
      const epochChanged = this.epoch !== state.connectionEpoch
      this.projection = state.projections
      this.epoch = state.connectionEpoch
      this.settled = settled
      this.observedRevision = this.revision
      let statusChanged = false
      for (const [sessionId, values] of Object.entries(state.projections)) {
        const sequence = this.inboxSequence(sessionId) ?? -1
        for (const callId of queuedQuestionReplyCallIds(values.inbox)) {
          const key = questionReplyKey(sessionId, callId)
          const previous = this.statuses.get(key)
          if (previous === undefined || (previous.state === 'released' && sequence > previous.asOfSequence)) {
            this.statuses.set(key, {
              type: 'question.reply.status',
              sessionId,
              callId,
              state: 'queued',
              asOfSequence: sequence,
            })
            statusChanged = true
          }
        }
      }
      if (statusChanged) {
        while (this.statuses.size > 4096) this.statuses.delete(this.statuses.keys().next().value!)
        this.statusSnapshot = Object.fromEntries([...this.statuses].map(([id, value]) => [id, value.state]))
      }
      for (const [key, reply] of this.replies) {
        const inbox = state.projections[reply.sessionId]?.inbox
        const queued = queuedQuestionReplyCallIds(inbox).has(reply.callId)
        if (
          this.settlements.hasCall(reply.sessionId, reply.callId) ||
          (reply.epoch !== state.connectionEpoch && !reply.accepted && !reply.seenQueued)
        ) {
          this.replies.delete(key)
        } else {
          if (queued) reply.seenQueued = true
          if (epochChanged && reply.accepted) {
            const epoch = state.connectionEpoch
            queueMicrotask(() => {
              if (this.replies.get(key) === reply && this.getState().connectionEpoch === epoch)
                void this.readReceipt(reply, epoch)
            })
          }
        }
      }
      this.keys = [...this.replies].filter(([, reply]) => reply.accepted).map(([key]) => key)
    }
    const keys = this.keys
    const previous = state.queuedQuestionReplies ?? []
    const withStatus =
      state.questionReplyStates === this.statusSnapshot
        ? state
        : { ...state, questionReplyStates: this.statusSnapshot }
    return keys.length === previous.length && keys.every((key, index) => previous[index] === key)
      ? withStatus
      : { ...withStatus, queuedQuestionReplies: keys }
  }

  public async request<T>(request: FeatureRequest): Promise<T> {
    if (request.type !== 'user-question.answer') return this.client.featureRequest<T>(request)
    const { sessionId, callId } = request.payload
    const state = this.getState()
    const key = questionReplyKey(sessionId, callId)
    const reply: Reply = {
      sessionId,
      callId,
      epoch: state.connectionEpoch,
      receiptSequence: undefined,
      reading: false,
      seenQueued: queuedQuestionReplyCallIds(state.projections[sessionId]?.inbox).has(callId),
      accepted: false,
    }
    this.replies.set(key, reply)
    this.revision++
    try {
      const result = await this.client.featureRequest<T>(request)
      const receipt = object(result)
      if (this.replies.get(key) === reply) {
        if (
          receipt?.kind === 'question.answer' &&
          receipt.accepted === true &&
          reply.epoch === this.getState().connectionEpoch
        ) {
          reply.accepted = true
          this.revision++
          this.setState((current) => this.reconcile(current))
          void this.readReceipt(reply, reply.epoch)
        } else this.replies.delete(key)
        this.revision++
        this.setState((current) => this.reconcile(current))
      }
      return result
    } catch (error) {
      if (this.replies.get(key) === reply) this.replies.delete(key)
      this.revision++
      this.setState((current) => this.reconcile(current))
      throw error
    }
  }

  private async readReceipt(reply: Reply, epoch: number | undefined): Promise<void> {
    const key = questionReplyKey(reply.sessionId, reply.callId)
    if (reply.reading || this.replies.get(key) !== reply || this.getState().connectionEpoch !== epoch) return
    reply.reading = true
    try {
      const result = object(
        await this.client.featureRequest<unknown>({
          type: 'user-question.reply.read',
          requestId: requestId(),
          payload: { sessionId: reply.sessionId, callId: reply.callId },
        }),
      )
      if (this.replies.get(key) !== reply || this.getState().connectionEpoch !== epoch) return
      const status = object(result?.status)
      if (
        result?.kind !== 'question.reply' ||
        status === undefined ||
        typeof status.asOfSequence !== 'number' ||
        !Number.isSafeInteger(status.asOfSequence) ||
        status.asOfSequence < -1
      )
        return
      reply.receiptSequence = status.asOfSequence
      if (
        status.state === 'queued' ||
        status.state === 'claimed' ||
        status.state === 'released' ||
        status.state === 'admitted' ||
        status.state === 'settled'
      ) {
        this.observe({
          type: 'question.reply.status',
          sessionId: reply.sessionId,
          callId: reply.callId,
          state: status.state,
          asOfSequence: status.asOfSequence,
        })
      }
      // The fresh read may itself see the discard. A newer live release may
      // also have overtaken this read; neither should be hidden by its receipt.
      const latest = this.statuses.get(key)
      if (latest?.state === 'released' && latest.asOfSequence >= status.asOfSequence) this.replies.delete(key)
    } catch {
      // The write already succeeded. Keep its latch, never resend it, and retry
      // only the read on a new connection epoch instead of spinning on replay.
    } finally {
      reply.reading = false
      this.revision++
      this.setState((current) => this.reconcile(current))
      const currentEpoch = this.getState().connectionEpoch
      if (currentEpoch !== epoch && this.replies.get(key) === reply && reply.accepted)
        queueMicrotask(() => {
          void this.readReceipt(reply, currentEpoch)
        })
    }
  }
}
