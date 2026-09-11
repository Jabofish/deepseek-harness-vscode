import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import { Rc6MessageFeedbackRepository } from '../src/repositories/feedback-repository.js'
import { Rc6ReferenceRepository } from '../src/repositories/reference-repository.js'

function transport(
  handler: (endpoint: string, args: Readonly<Record<string, unknown>>) => unknown,
): DshTransport & { readonly remoteRequestMock: ReturnType<typeof vi.fn> } {
  const remoteRequestMock = vi.fn(
    (endpoint: string, args: Readonly<Record<string, unknown>>, _signal?: AbortSignal) =>
      Promise.resolve(handler(endpoint, args)),
  )
  return {
    request: <T>() => Promise.resolve(undefined as T),
    remoteRequest: <T>(endpoint: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
      remoteRequestMock(endpoint, args, signal).then((value) => value as T),
    openEventStream: async function* () {
      /* fixture */
    },
    close: () => Promise.resolve(undefined),
    remoteRequestMock,
  }
}

describe('optional reference and feedback remotes', () => {
  it('uses the generated agentId wire field and keeps files before sessions', async () => {
    const client = transport((endpoint) =>
      endpoint === 'fileReferences/list'
        ? {
            ok: true,
            value: [
              { path: 'src/app.ts', kind: 'file' },
              { path: 'src', kind: 'directory' },
            ],
          }
        : {
            ok: true,
            value: [
              {
                sessionId: 's2',
                label: 'Review',
                cwd: 'workspace',
                sameWorkspace: true,
                createdAt: 10,
                mention: '@[Review](dsh-session:s2)',
              },
            ],
          },
    )
    const repository = new Rc6ReferenceRepository(client)

    await expect(repository.listFiles('s1', 'src')).resolves.toEqual([
      { path: 'src/app.ts', kind: 'file' },
      { path: 'src', kind: 'directory' },
    ])
    await expect(repository.listSessions('s1', 'Review')).resolves.toEqual([
      {
        sessionId: 's2',
        label: 'Review',
        cwd: 'workspace',
        sameWorkspace: true,
        createdAt: 10,
        mention: '@[Review](dsh-session:s2)',
      },
    ])
    expect(client.remoteRequestMock).toHaveBeenNthCalledWith(
      1,
      'fileReferences/list',
      { agentId: 's1', query: 'src' },
      undefined,
    )
    expect(client.remoteRequestMock).toHaveBeenNthCalledWith(
      2,
      'sessionReferenceResolver/candidates',
      { agentId: 's1', query: 'Review' },
      undefined,
    )
  })

  it('fails closed on malformed reference rows and rejects malformed outer values', async () => {
    const client = transport((endpoint) =>
      endpoint === 'fileReferences/list'
        ? {
            ok: true,
            value: [{ path: 'safe.md', kind: 'file' }, { path: 'broken.md' }],
          }
        : { ok: true, value: { not: 'an array' } },
    )
    const repository = new Rc6ReferenceRepository(client)
    await expect(repository.listFiles('s1', '')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(repository.listSessions('s1', '')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('fails closed when a session candidate omits a required field', async () => {
    const client = transport(() => ({
      ok: true,
      value: [
        {
          sessionId: 's2',
          label: 'Review',
          createdAt: 10,
          mention: '@[Review](dsh-session:s2)',
        },
      ],
    }))
    const repository = new Rc6ReferenceRepository(client)
    await expect(repository.listSessions('s1', '')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('treats an absent optional reference remote as empty but preserves cancellation', async () => {
    const unavailableClient = transport(() =>
      Promise.reject(
        new AppError({ code: 'CAPABILITY_UNAVAILABLE', message: 'not exposed', retryable: false }),
      ),
    )
    const unavailableRepository = new Rc6ReferenceRepository(unavailableClient)
    await expect(unavailableRepository.listFiles('s1', 'src')).resolves.toEqual([])
    await expect(unavailableRepository.listSessions('s1', 'src')).resolves.toEqual([])

    const cancelledClient = transport(() =>
      Promise.reject(new AppError({ code: 'REQUEST_CANCELLED', message: 'cancelled', retryable: false })),
    )
    const cancelledRepository = new Rc6ReferenceRepository(cancelledClient)
    await expect(cancelledRepository.listFiles('s1', 'src')).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
  })

  it('unwraps the Remote business union and carries the optimistic feedback version', async () => {
    const updated = {
      messageId: 'm1',
      rating: 'negative',
      note: 'needs work',
      category: 'task-result',
      version: 'v2',
      createdAt: 10,
      updatedAt: 20,
    } as const
    const client = transport((endpoint, args) => {
      if (endpoint === 'messageFeedback/list')
        return {
          ok: true,
          value: { ok: true, value: { items: [{ ...updated, rating: 'positive', version: 'v1' }] } },
        }
      if (endpoint === 'messageFeedback/put') return { ok: true, value: { ok: true, value: updated } }
      expect(endpoint).toBe('messageFeedback/delete')
      expect(args).toMatchObject({ request: { ifVersion: 'v2' } })
      return { ok: true, value: { ok: true, value: { absent: true } } }
    })
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.list('s1')).resolves.toMatchObject([{ messageId: 'm1', version: 'v1' }])
    await expect(repository.put('s1', 'm1', 'negative', 'needs work', 'task-result')).resolves.toEqual(
      updated,
    )
    expect(client.remoteRequestMock).toHaveBeenNthCalledWith(
      2,
      'messageFeedback/put',
      {
        request: {
          sessionId: 's1',
          messageId: 'm1',
          rating: 'negative',
          note: 'needs work',
          category: 'task-result',
          ifVersion: 'v1',
        },
      },
      undefined,
    )
    await expect(repository.remove('s1', 'm1')).resolves.toBeUndefined()
  })

  it('fails closed on malformed feedback rows instead of dropping or weakening them', async () => {
    const valid = {
      messageId: 'm1',
      rating: 'positive',
      version: 'v1',
      createdAt: 10,
      updatedAt: 20,
    } as const
    const malformedRows: readonly unknown[] = [
      { ...valid, createdAt: undefined },
      { ...valid, createdAt: 30, updatedAt: 20 },
      { ...valid, note: '   ' },
      { ...valid, category: 'not-a-feedback-category' },
      { ...valid, rating: 'unknown' },
      null,
    ]

    for (const item of malformedRows) {
      const client = transport((endpoint) => {
        expect(endpoint).toBe('messageFeedback/list')
        return { ok: true, value: { ok: true, value: { items: [item] } } }
      })
      const repository = new Rc6MessageFeedbackRepository(client)
      await expect(repository.list('s1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    }
  })

  it('observes the current item before deleting from a cold cache', async () => {
    const item = {
      messageId: 'm1',
      rating: 'positive',
      version: 'v7',
      createdAt: 1,
      updatedAt: 2,
    } as const
    const calls: string[] = []
    const client = transport((endpoint, args) => {
      calls.push(endpoint)
      if (endpoint === 'messageFeedback/list')
        return { ok: true, value: { ok: true, value: { items: [item] } } }
      expect(endpoint).toBe('messageFeedback/delete')
      // Upstream delete is a CAS on the observed version; absence is a
      // successful no-op, so the observation must supply the exact token.
      expect(args).toMatchObject({ request: { sessionId: 's1', messageId: 'm1', ifVersion: 'v7' } })
      return { ok: true, value: { ok: true, value: { absent: true } } }
    })
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.remove('s1', 'm1')).resolves.toBeUndefined()
    expect(calls).toEqual(['messageFeedback/list', 'messageFeedback/delete'])
  })

  it('skips the delete RPC when observation shows the item already absent', async () => {
    const calls: string[] = []
    const client = transport((endpoint) => {
      calls.push(endpoint)
      if (endpoint === 'messageFeedback/list') return { ok: true, value: { ok: true, value: { items: [] } } }
      throw new Error(`unexpected ${endpoint} for an absent item`)
    })
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.remove('s1', 'm1')).resolves.toBeUndefined()
    expect(calls).toEqual(['messageFeedback/list'])
  })

  it('adopts the authoritative current item from a version conflict before inviting a retry', async () => {
    const current = {
      messageId: 'm1',
      rating: 'negative',
      version: 'v9',
      createdAt: 1,
      updatedAt: 3,
    } as const
    let putCalls = 0
    const client = transport((endpoint, args) => {
      expect(endpoint).toBe('messageFeedback/put')
      putCalls += 1
      if (putCalls === 1)
        return { ok: true, value: { ok: false, error: { code: 'version-conflict', current } } }
      expect(args).toMatchObject({ request: { sessionId: 's1', messageId: 'm1', ifVersion: 'v9' } })
      return { ok: true, value: { ok: true, value: current } }
    })
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.put('s1', 'm1', 'positive')).rejects.toMatchObject({
      code: 'BACKEND_BUSY',
      retryable: true,
    })
    await expect(repository.put('s1', 'm1', 'negative')).resolves.toEqual(current)
  })

  it('treats an absent optional feedback remote as an empty list', async () => {
    const client = transport(() =>
      Promise.reject(
        new AppError({ code: 'CAPABILITY_UNAVAILABLE', message: 'not exposed', retryable: false }),
      ),
    )
    const repository = new Rc6MessageFeedbackRepository(client)
    await expect(repository.list('s1')).resolves.toEqual([])
  })

  it('maps an older host unknown-command response to optional capability absence', async () => {
    const client = transport(() =>
      Promise.reject(
        new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'unknown remote command',
          retryable: false,
          context: { rpcCode: 'unknown-command' },
        }),
      ),
    )
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.put('s1', 'm1', 'positive')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
  })

  it('maps the upstream Remote business unknown-command union to optional absence', async () => {
    const client = transport(() => ({
      ok: true,
      value: {
        ok: false,
        error: { code: 'unknown-command', message: 'messageFeedback/put is not registered' },
      },
    }))
    const repository = new Rc6MessageFeedbackRepository(client)

    await expect(repository.put('s1', 'm1', 'positive')).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'This DSH host does not expose message feedback.',
    })
  })
})
