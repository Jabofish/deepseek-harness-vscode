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

describe('rc.8 optional reference and feedback remotes', () => {
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
    await expect(repository.listSessions('s1', 'Review')).resolves.toMatchObject([
      { sessionId: 's2', mention: '@[Review](dsh-session:s2)' },
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

  it('drops malformed reference rows and rejects malformed outer values', async () => {
    const client = transport((endpoint) =>
      endpoint === 'fileReferences/list'
        ? {
            ok: true,
            value: [
              { path: 'safe.md', kind: 'file' },
              { path: '\u0000secret', kind: 'file' },
            ],
          }
        : { ok: true, value: { not: 'an array' } },
    )
    const repository = new Rc6ReferenceRepository(client)
    await expect(repository.listFiles('s1', '')).resolves.toEqual([{ path: 'safe.md', kind: 'file' }])
    await expect(repository.listSessions('s1', '')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('unwraps the Remote business union and carries the optimistic feedback version', async () => {
    const updated = {
      messageId: 'm1',
      rating: 'negative',
      note: 'needs work',
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
    await expect(repository.put('s1', 'm1', 'negative', 'needs work')).resolves.toEqual(updated)
    expect(client.remoteRequestMock).toHaveBeenNthCalledWith(
      2,
      'messageFeedback/put',
      {
        request: {
          sessionId: 's1',
          messageId: 'm1',
          rating: 'negative',
          note: 'needs work',
          ifVersion: 'v1',
        },
      },
      undefined,
    )
    await expect(repository.remove('s1', 'm1')).resolves.toBeUndefined()
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
