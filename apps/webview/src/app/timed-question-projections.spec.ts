import { describe, expect, it } from 'vitest'
import type { UserQuestion } from '@dsh-vscode/domain'
import {
  mergeLiveTimedQuestion,
  parseActiveTimedQuestions,
  questionFromProjection,
  queuedQuestionReplyCallIds,
} from './timed-question-projections.js'

const projection = {
  active: [
    {
      callId: 'call-1',
      state: 'continued',
      questions: [
        {
          id: 'scope',
          prompt: 'Which scope?',
          choices: [
            { id: 'workspace', label: 'workspace' },
            { id: 'all', label: 'all', description: 'All files' },
          ],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
  ],
  settled: [],
}

describe('timed user question projection', () => {
  it('recovers continued question cards from the durable projection', () => {
    const active = parseActiveTimedQuestions(projection)
    expect(active).toEqual([
      {
        callId: 'call-1',
        state: 'continued',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scope?',
            choices: [
              { id: 'workspace', label: 'workspace' },
              { id: 'all', label: 'all', description: 'All files' },
            ],
            multiSelect: false,
            allowFreeText: true,
          },
        ],
      },
    ])
    const question =
      active?.[0] === undefined ? undefined : questionFromProjection('session-1', active[0], true)
    expect(question).toMatchObject({
      sessionId: 'session-1',
      callId: 'call-1',
      timed: true,
      state: 'continued',
      replyQueued: true,
    })
  })

  it('does not turn the opt-in schema projection into a timeout claim for timeout -1', () => {
    const pending = parseActiveTimedQuestions({
      active: [
        {
          callId: 'call-indefinite',
          state: 'open',
          questions: [{ id: 'scope', prompt: 'Which scope?', allowFreeText: true }],
        },
      ],
      settled: [],
    })?.[0]
    if (pending === undefined) throw new Error('fixture requires an open projection')
    const live: UserQuestion = {
      id: 'scope',
      sessionId: 'session-1',
      prompt: 'Which scope?',
      allowFreeText: true,
    }

    const merged = mergeLiveTimedQuestion(live, pending, false)
    expect(merged).toMatchObject({ callId: 'call-indefinite', state: 'open' })
    expect(merged.timed).toBeUndefined()
    expect(mergeLiveTimedQuestion({ ...live, timed: true }, pending, false).timed).toBe(true)
  })

  it('fails closed on duplicate call ids, unknown states, and malformed questions', () => {
    expect(
      parseActiveTimedQuestions({ ...projection, active: [projection.active[0], projection.active[0]] }),
    ).toBeUndefined()
    expect(
      parseActiveTimedQuestions({ ...projection, active: [{ ...projection.active[0], state: 'settled' }] }),
    ).toBeUndefined()
    expect(
      parseActiveTimedQuestions({
        ...projection,
        active: [{ ...projection.active[0], questions: [{ id: 'q1', prompt: 14, allowFreeText: true }] }],
      }),
    ).toBeUndefined()
  })

  it('marks a late reply read-only only while its durable inbox item remains queued', () => {
    const inbox = {
      'next-step': [
        { source: { kind: 'user-question-reply', callId: 'call-1' } },
        { source: { kind: 'user-question-reply', callId: 'call-2' } },
      ],
      'next-turn': [{ source: { kind: 'ordinary-user-message' } }],
    }
    expect([...queuedQuestionReplyCallIds(inbox)]).toEqual(['call-1', 'call-2'])
  })
})
