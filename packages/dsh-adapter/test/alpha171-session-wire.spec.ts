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
