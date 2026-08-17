/**
 * Whole-session timing totals published by DSH's `sessionStats` projection.
 *
 * The projection is folded from durable session events, so it remains stable
 * when the visible conversation is paged or compacted. The field names mirror
 * the pinned upstream projection deliberately; the adapter never recomputes
 * these totals from rendered text.
 */
export interface SessionStatsProjection {
  readonly turns: number
  readonly steps: number
  readonly llmMs: number
  readonly toolMs: number
  readonly ttftMs: number
  readonly ttftSteps: number
  readonly decodeMs: number
  readonly decodeTokens: number
}
