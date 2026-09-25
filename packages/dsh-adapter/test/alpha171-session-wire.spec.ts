import { describe, expect, it } from 'vitest'
import {
  validAlpha171SessionEvent,
  validAlpha171SessionSnapshot,
  normalizeAlpha171Event,
} from '../src/versions/alpha171/session-wire.js'
import { rc6Mapper } from '../src/versions/rc6/mapper.js'

// Native V4 fixture from the pinned upstream developer.spec.ts, c36a83ff.
const header = { version: 4, id: 's1', createdAt: 1, isSeeded: false, delegationDepth: 0 }
const message = {
  id: 'd1',
  role: 'developer',
  source: { kind: 'tool-registry' },
  content: [
    { type: 'tool-addition', toolName: 'search' },
    { type: 'tool-removal', toolName: 'old' },
  ],
}
const developer = {
  type: 'developer/message',
  seq: 3,
  time: 4,
  surfaceOp: 'append',
  data: { turn: 1, step: 1, headerSeq: 2, message },
}
function snapshot(): Record<string, unknown> & { records: unknown[] } {
  return {
    type: 'snapshot',
    header,
    cursor: 3,
    hasMore: false,
    projections: { asOfSeq: 3, values: {} },
    records: [
      { type: 'event', event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
      { type: 'event', event: { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } } },
      {
        type: 'event',
        event: {
          type: 'request/header',
          seq: 2,
          time: 3,
          data: {
            reason: 'initial',
            header: {
              config: { provider: 'test', model: 'test' },
              tools: [{ name: 'search', description: 'Search', parameters: {}, deferLoading: true }],
            },
          },
        },
      },
      { type: 'event', event: developer },
    ],
  }
}
describe('native alpha171 Session V4 admission', () => {
  it('accepts developer additions/removals and maps a prompt-only watermark', () => {
    expect(validAlpha171SessionEvent(developer)).toBe(true)
    expect(validAlpha171SessionSnapshot(snapshot())).toBe(true)
    expect(normalizeAlpha171Event(developer)).toBe(developer)
    expect(rc6Mapper.event('developer/message', { ...developer.data, sessionId: 's1' })).toMatchObject({
      type: 'session.system',
    })
  })
  it('accepts an omitted top-level depth in the live V4 follow header', () => {
    // dsh-v0.1.7-rc.2 (477b4f4): core/session/src/types.ts makes top-level
    // delegationDepth absent, and session-controller/src/history.ts forwards
    // that header unchanged in session/follow. The artifact codec requires 0.
    const topLevelHeader = { version: 4, id: 's1', createdAt: 1, isSeeded: false }
    const liveSnapshot = { ...snapshot(), header: topLevelHeader }
    expect(validAlpha171SessionSnapshot(liveSnapshot)).toBe(true)
    expect(liveSnapshot.header).toEqual(topLevelHeader)
    expect(
      validAlpha171SessionSnapshot({
        ...snapshot(),
        header: { ...topLevelHeader, origin: 'subagent' },
      }),
    ).toBe(false)
    for (const delegationDepth of [-1, 0.5, undefined])
      expect(
        validAlpha171SessionSnapshot({
          ...snapshot(),
          header: { ...topLevelHeader, delegationDepth },
        }),
      ).toBe(false)
  })
  it('preserves the RC2 Auto review error identity through V4 normalization and tool mapping', () => {
    const denial = {
      type: 'tool/result',
      seq: 4,
      time: 5,
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        error: {
          name: 'AutoReviewDeniedError',
          code: 'AUTO_REVIEW_DENIED',
          reason: 'manual confirmation required',
        },
        message: {
          id: 'tool-message-denied',
          role: 'tool',
          source: { kind: 'tool', callId: 'call-auto-review-denied' },
          toolCallId: 'call-auto-review-denied',
          content: [{ type: 'text', text: 'reviewer result text' }],
          isError: true,
        },
      },
    }

    expect(validAlpha171SessionEvent(denial)).toBe(true)
    const normalized = normalizeAlpha171Event(denial)
    expect(normalized.data).toMatchObject({ error: denial.data.error })
    const mapped = rc6Mapper.event('tool/result', {
      sessionId: 's1',
      autoReviewDenialContract: true,
      data: normalized.data,
    })

    expect(mapped).toMatchObject({
      type: 'tool.updated',
      tool: {
        id: 'call-auto-review-denied',
        status: 'failed',
        autoReviewDenial: { reason: 'manual confirmation required' },
      },
    })
  })
  it.each([2, 3, 5])('rejects non-V4 header version %s', (version) => {
    expect(validAlpha171SessionSnapshot({ ...snapshot(), header: { ...header, version } })).toBe(false)
  })
  it.each([undefined, { kind: 'plugin', plugin: 'old' }, { kind: '' }])(
    'rejects invalid native source %j',
    (source) => {
      expect(
        validAlpha171SessionEvent({
          ...developer,
          data: { ...developer.data, message: { ...message, source } },
        }),
      ).toBe(false)
    },
  )
  it('rejects retired inline definitions, non-earlier headers and role mismatch', () => {
    expect(validAlpha171SessionEvent({ ...developer, data: { ...developer.data, headerSeq: 3 } })).toBe(false)
    expect(
      validAlpha171SessionEvent({
        ...developer,
        data: { ...developer.data, message: { ...message, role: 'user' } },
      }),
    ).toBe(false)
    expect(
      validAlpha171SessionEvent({
        ...developer,
        data: {
          ...developer.data,
          message: { ...message, content: [{ type: 'tool-addition', toolName: 'search', tool: {} }] },
        },
      }),
    ).toBe(false)
  })
  it('checks available header and lifecycle relationships without guessing missing pages', () => {
    const full = snapshot()
    full.records[3] = { type: 'event', event: { ...developer, data: { ...developer.data, headerSeq: 1 } } }
    expect(validAlpha171SessionSnapshot(full)).toBe(false)
    expect(
      validAlpha171SessionSnapshot({
        ...snapshot(),
        records: [{ type: 'event', event: developer }],
        hasMore: true,
      }),
    ).toBe(true)
    const wrongStep = snapshot()
    wrongStep.records[3] = { type: 'event', event: { ...developer, data: { ...developer.data, step: 2 } } }
    expect(validAlpha171SessionSnapshot(wrongStep)).toBe(false)
  })
  it('retains additive producer JSON and rejects unknown required vocabulary', () => {
    expect(validAlpha171SessionEvent({ ...developer, data: { ...developer.data, future: { a: 1 } } })).toBe(
      true,
    )
    expect(validAlpha171SessionEvent({ type: 'future/event', seq: 9, time: 9, data: {} })).toBe(false)
    expect(
      validAlpha171SessionEvent({ type: 'future/event', seq: 9, time: 9, data: {}, ignorable: true }),
    ).toBe(true)
  })
})
