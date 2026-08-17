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

  it('keeps a single custom answer as selected-free custom text', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, {
      id: 'q-free',
      rpcId: 'rpc-free',
      sessionId: 's1',
      prompt: 'Name the branch',
      allowFreeText: true,
    })

    await repository.respondToQuestion('q-free', 'feature/question-batch')

    expect(responses).toEqual([
      {
        rpcId: 'rpc-free',
        payload: {
          ok: true,
          value: {
            sessionId: 's1',
            answer: { answers: [{ id: 'q-free', selected: [], custom: 'feature/question-batch' }] },
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

  it('accepts an empty legacy selection array as a single-question Skip', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, {
      id: 'q-skip',
      rpcId: 'rpc-skip',
      sessionId: 's1',
      prompt: 'Optional question',
      allowFreeText: true,
    })

    await repository.respondToQuestion('q-skip', [])

    expect(responses[0]?.payload).toMatchObject({
      ok: true,
      value: { answer: { answers: [{ id: 'q-skip', selected: [] }] } },
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

  it('orders a complete batch exactly like the pending upstream questions', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await repository.respondToQuestion('q-plan', [
      { id: 'q-extra', response: ['Alice'] },
      { id: 'q-plan', response: 'Approve' },
    ])

    expect(responses[0]?.payload).toMatchObject({
      value: {
        answer: {
          answers: [
            { id: 'q-plan', selected: ['Approve'] },
            { id: 'q-extra', selected: ['Alice'] },
          ],
        },
      },
    })
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

  it('rejects a custom answer combined with a single-select option', async () => {
    const { transport } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await expect(
      repository.respondToQuestion('q-plan', [
        { id: 'q-plan', response: 'Approve', custom: 'and also change it' },
        { id: 'q-extra', response: ['Alice'] },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  it('forgets pending questions once the batch response is delivered', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())

    await repository.respondToQuestion('q-extra', [
      { id: 'q-plan', response: 'Decline' },
      { id: 'q-extra', response: ['Alice'] },
    ])
    await repository.respondToQuestion('q-extra', [
      { id: 'q-plan', response: 'Decline' },
      { id: 'q-extra', response: ['Alice'] },
    ])

    expect(responses).toHaveLength(1)
  })

  it('does not let an earlier answer suppress a later request that reuses the item id', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    const first = planReviewQuestion()
    rememberQuestion(repository, first)
    await repository.respondToQuestion('q-plan', [
      { id: 'q-plan', response: 'Approve' },
      { id: 'q-extra', response: ['Alice'] },
    ])

    rememberQuestion(repository, { ...first, rpcId: 'rpc-plan-2' })
    await repository.respondToQuestion('q-plan', [
      { id: 'q-plan', response: 'Decline' },
      { id: 'q-extra', response: ['Bob'] },
    ])

    expect(responses.map((entry) => entry.rpcId)).toEqual(['rpc-plan', 'rpc-plan-2'])
  })

  it('double submissions of the same batch collapse into one response', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())
    const answers = [
      { id: 'q-plan', response: 'Approve' },
      { id: 'q-extra', response: ['Alice'] },
    ] as const

    await Promise.all([
      repository.respondToQuestion('q-plan', answers),
      repository.respondToQuestion('q-plan', answers),
    ])

    expect(responses).toHaveLength(1)
  })

  it('collapses concurrent submissions made through different ids of the same batch', async () => {
    const { transport, responses } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())
    const answers = [
      { id: 'q-plan', response: 'Approve' },
      { id: 'q-extra', response: ['Alice'] },
    ] as const

    await Promise.all([
      repository.respondToQuestion('q-plan', answers),
      repository.respondToQuestion('q-extra', answers),
    ])

    expect(responses).toHaveLength(1)
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

describe('Rc6InteractionRepository permission replay hygiene', () => {
  it('drops remembered questions on session resubscribe', async () => {
    const { transport } = recordingTransport()
    const repository = new Rc6InteractionRepository(transport)
    rememberQuestion(repository, planReviewQuestion())
    repository.remember({
      type: 'session.subscribed',
      sessionId: 's1',
      lastSequence: 1,
    })

    await expect(repository.respondToQuestion('q-plan', 'Approve')).rejects.toMatchObject({
      code: 'STALE_INTERACTION',
    })
  })
})
