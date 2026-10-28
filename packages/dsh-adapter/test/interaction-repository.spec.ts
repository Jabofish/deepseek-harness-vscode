import { describe, expect, it } from 'vitest'
import type { BackendEvent, UserQuestion } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc6InteractionRepository } from '../src/repositories/interaction-repository.js'

function planReviewQuestion(): UserQuestion {
  return {
    id: 'q-plan',
    rpcId: 'rpc-plan',
    sessionId: 's1',
    prompt: 'Proceed with this plan?',
    detail: '1. Do it',
    header: 'Refactor',
    choices: [
      { id: 'Approve', label: 'Approve', description: 'Run the plan now' },
      { id: 'Decline', label: 'Decline', description: 'Stop here' },
    ],
    allowFreeText: true,
    intent: { kind: 'plan-review', approve: 'Approve' },
    items: [
      {
        id: 'q-plan',
        prompt: 'Proceed with this plan?',
        detail: '1. Do it',
        header: 'Refactor',
        choices: [
          { id: 'Approve', label: 'Approve', description: 'Run the plan now' },
          { id: 'Decline', label: 'Decline', description: 'Stop here' },
        ],
        allowFreeText: true,
        intent: { kind: 'plan-review', approve: 'Approve' },
      },
      {
        id: 'q-extra',
        prompt: 'Who to notify?',
        choices: [
          { id: 'Alice', label: 'Alice' },
          { id: 'Bob', label: 'Bob' },
        ],
        multiSelect: true,
        allowFreeText: true,
      },
    ],
  }
}

function recordingTransport(): {
  transport: DshTransport
  responses: { rpcId: string; payload: unknown }[]
} {
  const responses: { rpcId: string; payload: unknown }[] = []
  const transport: DshTransport = {
    request: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    remoteRequest: <TResponse>() => Promise.resolve({ result: { ok: true, value: [] } } as TResponse),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
    respondEnvelope: (rpcId: string, payload: unknown) => {
      responses.push({ rpcId, payload })
      return Promise.resolve({ accepted: true })
    },
  }
  return { transport, responses }
}

function rememberQuestion(repository: Rc6InteractionRepository, question: UserQuestion): void {
  const event: BackendEvent = { type: 'question.requested', question }
  repository.remember(event)
}

describe('Rc6InteractionRepository question batch answers', () => {
  it('retires a request on authoritative projection or late-reply admission without resending a mutation', () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    const first = { ...planReviewQuestion(), callId: 'call-one' }
    rememberQuestion(repository, first)
    repository.remember({
      type: 'session.projection',
      sessionId: 's1',
      key: 'userQuestions',
      value: { active: [], settled: [{ callId: first.callId, answers: [] }] },
    })
    expect(repository.sessionForQuestion('q-plan')).toBeUndefined()
    rememberQuestion(repository, { ...first, rpcId: 'rpc-next', callId: 'call-two' })
    repository.remember({
      type: 'question.reply.status',
      sessionId: 's1',
      callId: 'call-two',
      state: 'admitted',
      asOfSequence: 5,
    })
    expect(repository.sessionForQuestion('q-extra')).toBeUndefined()
    expect(responses).toEqual([])
  })
  it('retires an entire batch by any item and scopes resolution to its session and rpc identity', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    const first = planReviewQuestion()
    rememberQuestion(repository, first)
    repository.remember({ type: 'question.resolved', sessionId: 'other', questionRpcId: 'rpc-plan' })
    expect(repository.sessionForQuestion('q-extra')).toBe('s1')
    repository.remember({ type: 'question.resolved', sessionId: 's1', questionId: 'q-extra' })
    expect(repository.sessionForQuestion('q-plan')).toBeUndefined()
    rememberQuestion(repository, first)
    expect(repository.sessionForQuestion('q-plan')).toBeUndefined()
    rememberQuestion(repository, { ...first, rpcId: 'rpc-new' })
    repository.remember({
      type: 'question.resolved',
      sessionId: 's1',
      questionRpcId: 'rpc-plan',
      questionId: 'q-plan',
    })
    await repository.cancelQuestion('q-extra')
    expect(responses[0]?.rpcId).toBe('rpc-new')
  })

  it('refuses ambiguous item ids instead of responding to a different session and drops disconnected pending ids', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    const first = planReviewQuestion()
    rememberQuestion(repository, first)
    rememberQuestion(repository, { ...first, sessionId: 's2', rpcId: 'rpc-other' })
    await expect(repository.cancelQuestion('q-plan')).rejects.toMatchObject({ code: 'STALE_INTERACTION' })
    expect(responses).toEqual([])
    repository.remember({ type: 'connection.lost', reason: 'Disconnected' })
    expect(repository.sessionForQuestion('q-plan')).toBeUndefined()
  })
  it('answers every question of one ask in a single client-response', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await repository.respondToQuestion('q-plan', [
      { id: 'q-plan', response: 'Approve' },
      {
        id: 'q-extra',
        response: ['Alice', 'Bob'],
        custom: 'also ping the release channel',
      },
    ])

    expect(responses).toEqual([
      {
        rpcId: 'rpc-plan',
        payload: {
          ok: true,
          value: {
            sessionId: 's1',
            answer: {
              answers: [
                { id: 'q-plan', selected: ['Approve'] },
                {
                  id: 'q-extra',
                  selected: ['Alice', 'Bob'],
                  custom: 'also ping the release channel',
                },
              ],
            },
          },
        },
      },
    ])
  })

  it('accepts selected-free answers as the official per-question Skip encoding', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await repository.respondToQuestion('q-plan', [
      { id: 'q-plan', response: [] },
      { id: 'q-extra', response: [] },
    ])

    expect(responses[0]?.payload).toMatchObject({
      ok: true,
      value: {
        answer: {
          answers: [
            { id: 'q-plan', selected: [] },
            { id: 'q-extra', selected: [] },
          ],
        },
      },
    })
  })

  it('rejects free text when the pending item does not allow it', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, {
      id: 'q-choice-only',
      rpcId: 'rpc-choice-only',
      sessionId: 's1',
      prompt: 'Choose a mode',
      choices: [{ id: 'fast', label: 'Fast' }],
      allowFreeText: false,
    })

    await expect(repository.respondToQuestion('q-choice-only', 'custom mode')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    await expect(
      repository.respondToQuestion('q-choice-only', [
        { id: 'q-choice-only', response: 'Fast', custom: 'extra' },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(responses).toHaveLength(0)
  })

  it('cancels the whole pending ask with the pinned cancelled response envelope', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await repository.cancelQuestion('q-plan')
    await repository.cancelQuestion('q-extra')

    expect(responses).toEqual([
      {
        rpcId: 'rpc-plan',
        payload: {
          ok: false,
          error: {
            code: 'cancelled',
            message: 'the user closed this question request',
            details: {},
          },
        },
      },
    ])
  })

  it('rejects a batch that does not cover every pending question', async () => {
    const { transport } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await expect(
      repository.respondToQuestion('q-plan', [{ id: 'q-plan', response: 'Approve' }]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('rejects selected labels outside the pending options', async () => {
    const { transport } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await expect(
      repository.respondToQuestion('q-plan', [
        { id: 'q-plan', response: ['Not an option'] },
        { id: 'q-extra', response: ['Alice'] },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('does not consume a pending batch when the host rejects its response receipt', async () => {
    const responses: unknown[] = []
    let accepted = false
    const transport = recordingTransport().transport
    transport.respondEnvelope = (_rpcId, payload) => {
      responses.push(payload)
      return Promise.resolve(accepted ? { accepted: true } : { accepted: false, reason: 'not-pending' })
    }
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())
    const answers = [
      { id: 'q-plan', response: 'Approve' },
      { id: 'q-extra', response: ['Alice'] },
    ] as const

    await expect(repository.respondToQuestion('q-plan', answers)).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
    })
    accepted = true
    await expect(repository.respondToQuestion('q-plan', answers)).resolves.toBeUndefined()
    expect(responses).toHaveLength(2)
  })
})
