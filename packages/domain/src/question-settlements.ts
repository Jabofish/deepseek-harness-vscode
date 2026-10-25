import type { BackendEvent } from './events.js'
import type { UserQuestion } from './tools.js'

type Resolution = Extract<BackendEvent, { type: 'question.resolved' }>

/** Request identity takes precedence over reusable model-supplied item ids. */
export function matchesQuestionResolution(question: UserQuestion, event: Resolution): boolean {
  return (
    question.sessionId === event.sessionId &&
    (event.questionRpcId !== undefined
      ? question.rpcId === event.questionRpcId
      : event.questionId !== undefined &&
        (question.id === event.questionId ||
          question.items?.some((item) => item.id === event.questionId) === true))
  )
}

/** Bounded, connection-owned terminal facts; rereads do not undo settlements. */
export class QuestionSettlements {
  private readonly terminal = new Map<string, true>()
  private callSnapshot: readonly string[] | undefined

  public clear(): void {
    this.terminal.clear()
    this.callSnapshot = undefined
  }
  public settledCalls(): readonly string[] {
    return (this.callSnapshot ??= [...this.terminal.keys()].flatMap((key) => {
      const [session, kind, id] = JSON.parse(key) as [string, string, string]
      return kind === 'call' ? [JSON.stringify([session, id])] : []
    }))
  }

  public has(question: UserQuestion): boolean {
    return this.keys(question).some((key) => this.terminal.has(key))
  }
  public hasCall(sessionId: string, callId: string): boolean {
    return this.terminal.has(this.key(sessionId, 'call', callId))
  }
  public acceptCall(sessionId: string, callId: string): void {
    this.add(this.key(sessionId, 'call', callId))
  }
  public hasRpc(sessionId: string, rpcId: string): boolean {
    return this.terminal.has(this.key(sessionId, 'rpc', rpcId))
  }

  public accept(question: UserQuestion): void {
    for (const key of this.keys(question)) this.add(key)
  }

  public resolve(event: Resolution, pending: readonly UserQuestion[]): void {
    if (event.settledCallId !== undefined) this.acceptCall(event.sessionId, event.settledCallId)
    for (const question of pending)
      if (matchesQuestionResolution(question, event)) {
        // A timed waterfall's cancellation also means its foreground wait ended.
        // Only an accepted answer or durable settled projection closes the call;
        // its continued form must remain answerable through the Inbox Remote.
        if (event.outcome === 'answered' || question.callId === undefined) this.accept(question)
        else if (question.rpcId !== undefined) this.add(this.key(question.sessionId, 'rpc', question.rpcId))
      }
    if (event.questionRpcId !== undefined) this.add(this.key(event.sessionId, 'rpc', event.questionRpcId))
    else if (
      event.questionId !== undefined &&
      !pending.some((question) => matchesQuestionResolution(question, event))
    )
      this.add(this.key(event.sessionId, 'item', event.questionId))
  }

  /** Only the structured settled half is terminal; absence from active is not. */
  public project(sessionId: string, value: unknown): void {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('active' in value) ||
      !Array.isArray(value.active) ||
      !('settled' in value) ||
      !Array.isArray(value.settled)
    )
      return
    const settled: readonly unknown[] = value.settled
    if (!settled.every(validSettlement)) return
    for (const entry of settled) this.add(this.key(sessionId, 'call', entry.callId))
  }

  private keys(question: UserQuestion): string[] {
    const keys: string[] = []
    if (question.rpcId !== undefined) keys.push(this.key(question.sessionId, 'rpc', question.rpcId))
    if (question.callId !== undefined) keys.push(this.key(question.sessionId, 'call', question.callId))
    if (keys.length === 0) keys.push(this.key(question.sessionId, 'item', question.id))
    return keys
  }

  private key(session: string, kind: string, id: string): string {
    return JSON.stringify([session, kind, id])
  }
  private add(key: string): void {
    if (this.terminal.has(key)) return
    this.callSnapshot = undefined
    this.terminal.set(key, true)
    while (this.terminal.size > 4096) this.terminal.delete(this.terminal.keys().next().value!)
  }
}

function validSettlement(
  value: unknown,
): value is { readonly callId: string; readonly answers: readonly unknown[] } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('callId' in value) ||
    typeof value.callId !== 'string' ||
    value.callId.trim() === '' ||
    !('answers' in value) ||
    !Array.isArray(value.answers)
  )
    return false
  return value.answers.every(
    (answer: unknown) =>
      typeof answer === 'object' &&
      answer !== null &&
      'id' in answer &&
      typeof answer.id === 'string' &&
      'selected' in answer &&
      Array.isArray(answer.selected) &&
      answer.selected.every((entry: unknown) => typeof entry === 'string') &&
      (!('custom' in answer) || typeof answer.custom === 'string'),
  )
}
