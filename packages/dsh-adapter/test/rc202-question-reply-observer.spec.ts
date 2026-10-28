import { describe, expect, it } from 'vitest'
import { Rc202QuestionReplyObserver } from '../src/versions/rc202/question-reply-observer.js'
import { normalizeEnvelope } from '../src/stream-envelopes.js'

// Native Inbox contract, pinned at alpha.2 d74326738864 and unchanged at
// rc.3 1f81c047fc48: core/agent-loop/src/inbox.ts and user-questions/src/index.ts.
const reply = (id = 'm', callId = 'call'): Record<string, unknown> => ({
  id,
  source: { kind: 'user-question-reply', callId },
  content: [{ type: 'text', text: 'private answer body' }],
})
const projection = (pending: readonly unknown[] = []): unknown => ({
  asOfSeq: 0,
  values: {
    inbox: { 'next-turn': pending, 'next-step': [] },
    userQuestions: { active: [{ callId: 'call', state: 'continued' }], settled: [] },
  },
})
const event = (seq: number, type: string, data: unknown): Record<string, unknown> => ({ seq, type, data })

describe('timed reply Inbox lifecycle', () => {
  it('recovers an explicit discard from snapshot history after the follow stream was closed', () => {
    const observer = new Rc202QuestionReplyObserver('s1')
    const history = [
      event(5, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [reply()] }),
      event(6, 'agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      }),
    ]
    expect(observer.snapshot({ ...(projection() as object), asOfSeq: 6 }, history)).toContainEqual({
      type: 'question/reply-status',
      sessionId: 's1',
      callId: 'call',
      state: 'released',
      asOfSequence: 6,
    })
  })

  it('distinguishes claiming from discard and admission without exposing content', () => {
    const observer = new Rc202QuestionReplyObserver('s1')
    const queued = observer.snapshot(projection([reply()]), [])
    expect(queued[0]).toMatchObject({ callId: 'call', state: 'queued' })
    observer.accept(event(1, 'turn/start', { turn: 1 }))
    const claimed = observer.accept(
      event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    )
    expect(claimed[0]).toMatchObject({ state: 'claimed' })
    const admitted = observer.accept(
      event(3, 'user/message', {
        source: { kind: 'user-question-reply', callId: 'call', outcome: 'answered' },
      }),
    )
    expect(admitted[0]).toMatchObject({ state: 'admitted' })
    expect(observer.accept(event(4, 'turn/end', { turn: 1 }))).toEqual([])
    for (const frame of [...queued, ...claimed, ...admitted]) {
      expect(JSON.stringify(frame)).not.toContain('private answer body')
      expect(normalizeEnvelope(frame)).toMatchObject({
        type: 'question.reply.status',
        sessionId: 's1',
        callId: 'call',
      })
    }
    const discarded = new Rc202QuestionReplyObserver('s1')
    discarded.snapshot(projection([reply()]), [])
    expect(
      discarded.accept(
        event(1, 'agent/inbox/spliced', {
          target: 'next-turn',
          start: 0,
          removedCount: 1,
          inserted: [],
          outcome: 'canceled',
        }),
      )[0],
    ).toMatchObject({ state: 'released' })
  })

  it('releases a claimed reply after a rejected or cancelled turn and seeds recovery from a complete baseline', () => {
    const observer = new Rc202QuestionReplyObserver('s1')
    observer.snapshot(projection([reply()]), [])
    observer.accept(event(1, 'turn/start', { turn: 7 }))
    observer.accept(
      event(2, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
    )
    expect(observer.accept(event(3, 'turn/end', { turn: 7 }))[0]).toMatchObject({ state: 'released' })
    expect(observer.snapshot(projection(), [event(0, 'turn/end', { turn: 7 })])[0]).toMatchObject({
      state: 'released',
    })
    expect(observer.snapshot(projection(), [event(0, 'turn/start', { turn: 8 })])).toEqual([])
  })
})
