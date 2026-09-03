import { describe, expect, it } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import { Rc6SkillRepository } from '../src/repositories/skill-repository.js'

interface Call {
  method: string
  params: unknown
}

function transportFor(value: unknown, calls: Call[] = []): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      return Promise.resolve({ result: { ok: true, value } } as TResponse)
    },
    remoteRequest: <TResponse>() => Promise.reject<TResponse>(new Error('unexpected Remote')),
    openEventStream: async function* () {
      /* fixture stream */
    },
    close: () => Promise.resolve(),
  }
}

describe('Rc6SkillRepository skill.list', () => {
  it('preserves the optional upstream whenToUse routing guidance', async () => {
    const calls: Call[] = []
    const repository = new Rc6SkillRepository(
      transportFor(
        {
          skills: [
            {
              name: 'code-review',
              description: 'Review changes.',
              whenToUse: 'Use for focused review requests.',
              modelInvocable: true,
            },
            { name: 'private-note', description: 'A user-only skill.', modelInvocable: false },
          ],
        },
        calls,
      ),
    )

    await expect(repository.list('session-1')).resolves.toEqual([
      {
        id: 'code-review',
        name: 'code-review',
        description: 'Review changes.',
        whenToUse: 'Use for focused review requests.',
        source: 'project',
        enabled: true,
      },
      {
        id: 'private-note',
        name: 'private-note',
        description: 'A user-only skill.',
        source: 'project',
        enabled: false,
      },
    ])
    expect(calls).toEqual([{ method: 'skill.list', params: { sessionId: 'session-1' } }])
  })

  it('rejects a malformed optional whenToUse value instead of silently dropping it', async () => {
    const repository = new Rc6SkillRepository(
      transportFor({
        skills: [
          { name: 'code-review', description: 'Review changes.', whenToUse: 42, modelInvocable: true },
        ],
      }),
    )

    await expect(repository.list('session-1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
