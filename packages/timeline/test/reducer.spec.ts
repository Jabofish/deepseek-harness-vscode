import { describe, it } from 'vitest'

describe('reduceTimeline', () => {
  it.todo('appends ordered message deltas to the stable message node')
  it.todo('ignores duplicate and stale event sequence numbers')
  it.todo('upserts tool calls, goals, jobs, and subagents by stable id')
  it.todo('replays the same event log to the same immutable state')
  it.todo('handles unknown rc6 events without losing later known events')
})
