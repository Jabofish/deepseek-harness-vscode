/** Host authority for one cue per live, successfully completed turn. */
export class CompletionCue {
  private readonly turns = new Map<string, { turn: number; readyAt?: number }>()

  public constructor(
    private readonly options: {
      readonly mode: () => unknown
      readonly focused: () => boolean
      readonly notify: () => void
      readonly now?: () => number
    },
  ) {}

  public accept(name: string, payload: unknown): void {
    if (name === 'connection.snapshot') {
      this.turns.clear()
      return
    }
    if (typeof payload !== 'object' || payload === null) return
    const value = payload as Record<string, unknown>
    if (value.replayed === true || typeof value.sessionId !== 'string') return
    if (name === 'session.removed') {
      this.turns.delete(value.sessionId)
      return
    }
    if (!Number.isSafeInteger(value.turn) || (value.turn as number) < 0) return
    if (name === 'turn.started') {
      this.turns.delete(value.sessionId)
      this.turns.set(value.sessionId, { turn: value.turn as number })
      while (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!)
    } else if (name === 'turn.ended') {
      const current = this.turns.get(value.sessionId)
      if (current === undefined || current.turn !== value.turn) return
      if (value.reason === 'completed' && value.failure === undefined)
        current.readyAt ??= (this.options.now ?? Date.now)()
      else this.turns.delete(value.sessionId)
    }
  }

  /** Called after the renderer commits the final response, never on transport receipt. */
  public rendered(sessionId: string, turn: number): { bell: boolean } {
    const current = this.turns.get(sessionId)
    if (current?.turn !== turn || current.readyAt === undefined) return { bell: false }
    this.turns.delete(sessionId)
    const age = (this.options.now ?? Date.now)() - current.readyAt
    if (age < 0 || age > 60_000 || this.options.focused()) return { bell: false }
    const mode = this.options.mode()
    if (mode === 'notification') this.options.notify()
    return { bell: mode === 'bell' }
  }
}
