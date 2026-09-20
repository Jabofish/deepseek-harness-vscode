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
              path: '/fixture/skills/review/SKILL.md',
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

    // The catalog carries no origin and no "disabled" state: the host lists the
    // skills a human may run and only says whether the model may pick them too.
    // Neither fact may be invented, so a row has exactly what the host sent.
    await expect(repository.list('session-1')).resolves.toEqual([
      {
        id: 'code-review',
        documentPath: '/fixture/skills/review/SKILL.md',
        name: 'code-review',
        description: 'Review changes.',
        whenToUse: 'Use for focused review requests.',
        enabled: true,
      },
      {
        id: 'private-note',
        name: 'private-note',
        description: 'A user-only skill.',
        enabled: false,
      },
    ])
    expect(calls).toEqual([{ method: 'skill.list', params: { sessionId: 'session-1' } }])
  })

  it('keeps a user-only skill usable rather than reporting it disabled', async () => {
    const repository = new Rc6SkillRepository(
      transportFor({ skills: [{ name: 'private-note', description: 'User only.', modelInvocable: false }] }),
    )

    const [skill] = await repository.list('session-1')
    expect(skill?.source, 'the host never reports an origin, so none may be fabricated').toBeUndefined()
    expect(skill?.enabled, 'user-only is not disabled').toBe(false)
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

describe('skill documentation wire validation', () => {
  it.each([null, 42, ''])('rejects malformed path %j', async (path) => {
    const repository = new Rc6SkillRepository(
      transportFor({ skills: [{ name: 'review', description: '', modelInvocable: true, path }] }),
    )
    await expect(repository.list('session')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
