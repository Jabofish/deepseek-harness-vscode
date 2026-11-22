const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

/** Text of the unfocused-window notification. */
export const COMPLETION_CUE_NOTIFICATION = 'JaboDSH response is ready.'
/** Input requests are not completions; say what the cue is for. */
export const COMPLETION_CUE_INPUT_NOTIFICATION = 'JaboDSH needs your input.'

export type CompletionCueMode = 'notification' | 'bell' | 'off'

export type CompletionCueInputKind = 'question' | 'permission'

/** Focus and a chime target for a question or approval that needs the user. */
export interface CompletionCueInputContext {
  readonly focused: boolean
  readonly bell: () => void
}

/** Redaction-safe decisions recorded in the Host diagnostics channel. */
export type CompletionCueLogEvent =
  | { readonly decision: 'armed'; readonly turn: number }
  | {
      readonly decision: 'suppressed'
      readonly reason: 'no-live-turn' | 'expired' | 'focused' | 'off'
      readonly turn: number
      readonly ageMs?: number
    }
  | {
      readonly decision: 'delivered'
      readonly mode: Exclude<CompletionCueMode, 'off'>
      readonly turn: number
      readonly ageMs: number
    }
  | { readonly decision: 'test'; readonly mode: CompletionCueMode }
  | { readonly decision: 'notified'; readonly native: boolean }
  | {
      readonly decision: 'needs-input'
      readonly kind: CompletionCueInputKind
      readonly mode: CompletionCueMode
      readonly focused: boolean
      readonly delivered: boolean
    }

/** Host authority for one cue per live, successfully completed turn. */
export class CompletionCue {
  private readonly turns = new Map<string, { turn: number; readyAt?: number }>()
  private readonly needsInputSeen = new Set<string>()

  public constructor(
    private readonly options: {
      readonly mode: () => unknown
      /** VS Code's window focus. On Linux it can stay stale, so a renderer-supplied focus wins. */
      readonly focused: () => boolean
      /** Opt-in: cue even while the chat is watched, as the issue's completion cue asks. */
      readonly includeFocused?: () => boolean
      readonly notify: (reason: 'turn' | CompletionCueInputKind) => void
      /** Resolves focus and a Webview that can chime for a needs-input event. */
      readonly needsInput?: (sessionId: string) => CompletionCueInputContext | undefined
      readonly now?: () => number
      readonly log?: (event: CompletionCueLogEvent) => void
    },
  ) {}

  public mode(): CompletionCueMode {
    const mode = this.options.mode()
    return mode === 'notification' || mode === 'bell' ? mode : 'off'
  }

  public accept(name: string, payload: unknown): void {
    if (name === 'connection.snapshot') {
      this.turns.clear()
      this.needsInputSeen.clear()
      return
    }
    if (typeof payload !== 'object' || payload === null) return
    if (name === 'question.requested' || name === 'permission.requested') {
      this.cueNeedsInput(name === 'question.requested' ? 'question' : 'permission', payload)
      return
    }
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
      if (value.reason === 'completed' && value.failure === undefined) {
        if (current.readyAt === undefined) {
          current.readyAt = (this.options.now ?? Date.now)()
          this.options.log?.({ decision: 'armed', turn: current.turn })
        }
      } else this.turns.delete(value.sessionId)
    }
  }

  /**
   * Cue once when the agent stops to ask a question or wait for an approval.
   * The card is rendered by the Webview; the Host only needs focus and a
   * surface that can chime.
   */
  private cueNeedsInput(kind: CompletionCueInputKind, payload: unknown): void {
    const value = asRecord(payload)
    if (value?.replayed === true) return
    const request = asRecord(kind === 'question' ? value?.question : value?.request)
    const id = request?.id
    const sessionId = request?.sessionId
    if (typeof id !== 'string' || typeof sessionId !== 'string') return
    // A continued or already-answered question is a read-only receipt.
    if (kind === 'question' && (request?.state === 'continued' || request?.replyQueued === true)) return
    const key = JSON.stringify([sessionId, kind, id])
    if (this.needsInputSeen.has(key)) return
    this.needsInputSeen.add(key)
    while (this.needsInputSeen.size > 256)
      this.needsInputSeen.delete(this.needsInputSeen.values().next().value!)
    const context = this.options.needsInput?.(sessionId)
    const focused = context?.focused ?? this.options.focused()
    const mode = this.mode()
    const delivered = mode !== 'off' && (focused !== true || this.options.includeFocused?.() === true)
    this.options.log?.({ decision: 'needs-input', kind, mode, focused, delivered })
    if (!delivered) return
    if (mode === 'notification') this.options.notify(kind)
    else context?.bell()
  }

  /**
   * Called after the renderer commits the final response, never on transport
   * receipt. `chatFocused` comes from the renderer's `document.hasFocus()`:
   * when it is present it decides, because VS Code's window focus can stay
   * stale on Linux window managers.
   */
  public rendered(sessionId: string, turn: number, chatFocused?: boolean): { bell: boolean } {
    const current = this.turns.get(sessionId)
    if (current?.turn !== turn || current.readyAt === undefined) {
      this.options.log?.({ decision: 'suppressed', reason: 'no-live-turn', turn })
      return { bell: false }
    }
    this.turns.delete(sessionId)
    const age = (this.options.now ?? Date.now)() - current.readyAt
    if (age < 0 || age > 60_000) {
      this.options.log?.({ decision: 'suppressed', reason: 'expired', turn, ageMs: age })
      return { bell: false }
    }
    const focused = chatFocused ?? this.options.focused()
    if (focused && this.options.includeFocused?.() !== true) {
      this.options.log?.({ decision: 'suppressed', reason: 'focused', turn, ageMs: age })
      return { bell: false }
    }
    const mode = this.mode()
    if (mode === 'off') {
      this.options.log?.({ decision: 'suppressed', reason: 'off', turn, ageMs: age })
      return { bell: false }
    }
    if (mode === 'notification') this.options.notify('turn')
    this.options.log?.({ decision: 'delivered', mode, turn, ageMs: age })
    return { bell: mode === 'bell' }
  }
}
