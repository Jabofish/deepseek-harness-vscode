import { recordOrUndefined as record } from '../alpha/remote-mux.js'

type Entry = { readonly id: string; readonly callId?: string }
type Lists = Record<'next-turn' | 'next-step', readonly Entry[]>
type ReplyState = 'queued' | 'claimed' | 'released' | 'admitted'
type ReplyFrame = {
  readonly type: 'question/reply-status'
  readonly sessionId: string
  readonly callId: string
  readonly state: ReplyState
  readonly asOfSequence: number
}

/** Metadata-only fold of the pinned native Inbox splice contract. No message bodies. */
export class Rc202QuestionReplyObserver {
  private inbox: Lists | undefined
  private sequence = -1
  private turn: number | undefined
  private readonly claimed = new Map<string, number | undefined>()
  public constructor(private readonly sessionId: string) {}

  public snapshot(projection: unknown, events: readonly Record<string, unknown>[]): readonly ReplyFrame[] {
    const block = record(projection)
    const values = record(block?.values)
    const inbox = record(values?.inbox)
    const nextTurn = entries(inbox?.['next-turn'])
    const nextStep = entries(inbox?.['next-step'])
    this.inbox =
      nextTurn === undefined || nextStep === undefined
        ? undefined
        : { 'next-turn': nextTurn, 'next-step': nextStep }
    this.sequence = typeof block?.asOfSeq === 'number' ? block.asOfSeq : -1
    this.turn = undefined
    for (const event of events) {
      const data = record(event.data)
      if (event.type === 'turn/start' && typeof data?.turn === 'number') this.turn = data.turn
      if (event.type === 'turn/end') this.turn = undefined
    }
    const pending = [...(nextTurn ?? []), ...(nextStep ?? [])]
    const frames = pending.flatMap((entry) =>
      entry.callId === undefined ? [] : [this.frame(entry.callId, 'queued')],
    )
    const questions = record(values?.userQuestions)
    const active = Array.isArray(questions?.active) ? (questions.active as readonly unknown[]) : []
    const activeCalls = new Set(
      active.flatMap((value) => {
        const question = record(value)
        return typeof question?.callId === 'string' && question.state === 'continued' ? [question.callId] : []
      }),
    )
    // A panel may first subscribe after the native claim already removed the
    // reply from Inbox. Recover only identities from the supplied recent log;
    // never execute or requeue the messages being inspected.
    const recovered = this.recoverReplies(events)
    for (const [callId, state] of recovered.states)
      if (state === 'released' || state === 'admitted') {
        this.claimed.delete(callId)
        if (
          state === 'admitted' ||
          (activeCalls.has(callId) && !pending.some((entry) => entry.callId === callId))
        )
          frames.push(this.frame(callId, state))
      }
    for (const [callId, turn] of recovered.claimed) this.claimed.set(callId, turn)
    for (const [callId, turn] of this.claimed) {
      if (!activeCalls.has(callId) || (this.turn !== undefined && turn !== this.turn))
        this.claimed.delete(callId)
      else if (!pending.some((entry) => entry.callId === callId)) frames.push(this.frame(callId, 'claimed'))
    }
    // A settled turn releases every claimed reply in the service. With an idle
    // baseline and no pending Inbox entry, reread can authoritatively unlock it.
    if (
      this.inbox !== undefined &&
      (events.at(-1)?.type === 'turn/end' ||
        (events.some((event) => event.type === 'turn/end') && this.turn === undefined))
    ) {
      this.claimed.clear()
      for (const callId of activeCalls)
        if (!pending.some((entry) => entry.callId === callId)) frames.push(this.frame(callId, 'released'))
    }
    return frames
  }

  public accept(event: Record<string, unknown>): readonly ReplyFrame[] {
    if (typeof event.seq !== 'number' || event.seq <= this.sequence) return []
    // A missing splice cannot safely be reconstructed from a later index.
    if (this.sequence >= 0 && event.seq !== this.sequence + 1) this.inbox = undefined
    this.sequence = event.seq
    const data = record(event.data)
    if (data === undefined) return []
    if (event.type === 'turn/start' && typeof data.turn === 'number') this.turn = data.turn
    if (event.type === 'user/message') {
      const source = record(data.source)
      if (
        source?.kind === 'user-question-reply' &&
        source.outcome === 'answered' &&
        typeof source.callId === 'string'
      ) {
        this.claimed.delete(source.callId)
        return [this.frame(source.callId, 'admitted')]
      }
    }
    if (event.type === 'turn/end') {
      const frames: ReplyFrame[] = []
      for (const [callId, turn] of this.claimed)
        if (turn === undefined || turn === data.turn) {
          this.claimed.delete(callId)
          frames.push(this.frame(callId, 'released'))
        }
      this.turn = undefined
      return frames
    }
    if (event.type !== 'agent/inbox/spliced' || this.inbox === undefined) return []
    const target = data.target
    const start = data.start
    const count = data.removedCount ?? 0
    const inserted = entries(data.inserted)
    if (
      (target !== 'next-step' && target !== 'next-turn') ||
      typeof start !== 'number' ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      inserted === undefined ||
      start + count > this.inbox[target].length
    ) {
      this.inbox = undefined
      return []
    }
    const removed = this.inbox[target].slice(start, start + count)
    this.inbox[target] = this.inbox[target].toSpliced(start, count, ...inserted)
    const frames: ReplyFrame[] = []
    for (const entry of removed)
      if (entry.callId !== undefined) {
        const state = data.outcome === 'canceled' ? 'released' : 'claimed'
        if (state === 'claimed') this.claimed.set(entry.callId, this.turn)
        else this.claimed.delete(entry.callId)
        frames.push(this.frame(entry.callId, state))
      }
    for (const entry of inserted)
      if (entry.callId !== undefined) frames.push(this.frame(entry.callId, 'queued'))
    return frames
  }

  private frame(callId: string, state: ReplyState): ReplyFrame {
    return {
      type: 'question/reply-status',
      sessionId: this.sessionId,
      callId,
      state,
      asOfSequence: this.sequence,
    }
  }

  private recoverReplies(events: readonly Record<string, unknown>[]): {
    readonly claimed: ReadonlyMap<string, number | undefined>
    readonly states: ReadonlyMap<string, ReplyState>
  } {
    const fold = new Rc202QuestionReplyObserver(this.sessionId)
    const states = new Map<string, ReplyState>()
    const empty = (): Lists => ({ 'next-turn': [], 'next-step': [] })
    fold.inbox = empty()
    for (const event of events) {
      const data = record(event.data)
      if (typeof event.seq !== 'number') continue
      if (
        fold.sequence < 0 ||
        event.seq !== fold.sequence + 1 ||
        (event.type === 'system/message' && data !== undefined && Object.keys(data).length === 0)
      ) {
        fold.inbox = empty()
        fold.claimed.clear()
        states.clear()
        fold.sequence = event.seq - 1
      }
      // The history window can start with pre-existing ordinary messages. Their
      // identities are irrelevant, but their positions must be accounted for.
      // Bound this optional reconstruction instead of allocating from an index.
      if (
        event.type === 'agent/inbox/spliced' &&
        data !== undefined &&
        fold.inbox !== undefined &&
        (data.target === 'next-turn' || data.target === 'next-step') &&
        typeof data.start === 'number' &&
        Number.isSafeInteger(data.start) &&
        data.start >= 0
      ) {
        const count = data.removedCount ?? 0
        if (
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          data.start + count > 4096
        )
          fold.inbox = undefined
        else {
          const list = [...fold.inbox[data.target]]
          while (list.length < data.start + count) list.push({ id: '' })
          fold.inbox[data.target] = list
        }
      }
      for (const frame of fold.accept(event)) {
        states.set(frame.callId, frame.state)
        while (states.size > 4096) states.delete(states.keys().next().value!)
      }
    }
    return { claimed: fold.claimed, states }
  }
}

function entries(value: unknown): readonly Entry[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: Entry[] = []
  for (const item of value) {
    const message = record(item)
    if (typeof message?.id !== 'string' || message.id === '') return undefined
    const source = record(message.source)
    result.push({
      id: message.id,
      ...(source?.kind === 'user-question-reply' && typeof source.callId === 'string' && source.callId !== ''
        ? { callId: source.callId }
        : {}),
    })
  }
  return result
}
