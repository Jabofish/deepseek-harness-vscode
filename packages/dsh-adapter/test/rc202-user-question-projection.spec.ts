import { describe, expect, it } from 'vitest'
import {
  mapRc202BackendEvent,
  mapRc202ProjectionValues,
  mapRc202UserQuestionProjection,
} from '../src/versions/rc202/user-question-projections.js'

const wireProjection = {
  active: [
    {
      callId: 'call-1',
      questions: [
        {
          id: 'scope',
          question: 'Which scope?',
          detail: 'Choose the smallest useful scope.',
          header: 'Scope',
          options: [{ label: 'workspace', description: 'Current workspace only' }],
          multiSelect: false,
        },
      ],
      state: 'continued',
    },
  ],
  settled: [{ callId: 'call-0', answers: [{ id: 'plan', selected: ['approve'], custom: 'ship it' }] }],
} as const

describe('DSH 0.2.0-rc.2 userQuestions projection contract', () => {
  it('maps active questions and settled answers into the domain vocabulary', () => {
    expect(mapRc202UserQuestionProjection(wireProjection)).toEqual({
      active: [
        {
          callId: 'call-1',
          state: 'continued',
          questions: [
            {
              id: 'scope',
              prompt: 'Which scope?',
              detail: 'Choose the smallest useful scope.',
              header: 'Scope',
              choices: [{ id: 'workspace', label: 'workspace', description: 'Current workspace only' }],
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        },
      ],
      settled: [{ callId: 'call-0', answers: [{ id: 'plan', selected: ['approve'], custom: 'ship it' }] }],
    })
  })

  it('maps the versioned live event, subscription, and baseline projection entrances', () => {
    const sessionProjection = mapRc202BackendEvent({
      type: 'session.projection',
      sessionId: 'session-1',
      key: 'userQuestions',
      value: wireProjection,
    })
    expect(sessionProjection).toMatchObject({
      type: 'session.projection',
      key: 'userQuestions',
      value: { active: [{ questions: [{ prompt: 'Which scope?' }] }] },
    })

    const subscribed = mapRc202BackendEvent({
      type: 'session.subscribed',
      sessionId: 'session-1',
      lastSequence: 4,
      projection: { asOfSequence: 4, values: { userQuestions: wireProjection } },
    })
    expect(subscribed).toMatchObject({
      type: 'session.subscribed',
      projection: { values: { userQuestions: { active: [{ questions: [{ prompt: 'Which scope?' }] }] } } },
    })

    const baseline = mapRc202BackendEvent({
      type: 'session.projection.baseline',
      projections: {
        'session-1': { asOfSequence: 4, values: { userQuestions: wireProjection } },
      },
    })
    expect(baseline).toMatchObject({
      projections: {
        'session-1': { values: { userQuestions: { active: [{ questions: [{ prompt: 'Which scope?' }] }] } } },
      },
    })
  })

  it('normalizes projection snapshots and rejects unknown or malformed upstream fields', () => {
    expect(mapRc202ProjectionValues({ inbox: { queued: [] }, userQuestions: wireProjection })).toMatchObject({
      inbox: { queued: [] },
      userQuestions: { active: [{ questions: [{ prompt: 'Which scope?' }] }] },
    })
    expect(() =>
      mapRc202UserQuestionProjection({ ...wireProjection, privatePayload: 'must not cross' }),
    ).toThrow(/malformed 0\.2\.0-rc\.2 user question projection/u)
    expect(() =>
      mapRc202UserQuestionProjection({
        ...wireProjection,
        active: [{ ...wireProjection.active[0], questions: [{ id: 'scope', question: 7 }] }],
      }),
    ).toThrow(/malformed 0\.2\.0-rc\.2 user question projection/u)
  })
})
