import { describe, expect, it, vi } from 'vitest'

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

  it('keeps every other sidecar refusal distinct from an absent capability', async () => {
    // A live sidecar answers `target-not-found` for a message that is not in
    // the session log, and `note-blank`/`note-too-large` for a note its own
    // policy rejects. Reporting any of them as CAPABILITY_UNAVAILABLE would
    // make the Webview hide the whole feedback surface for a session whose
    // feedback works, so each refusal must keep its own code and host code.
    const refusals = [
      { code: 'target-not-found', expected: 'STALE_INTERACTION', retryable: false },
      { code: 'session-not-found', expected: 'BACKEND_UNREACHABLE', retryable: false },
      { code: 'note-blank', expected: 'INVALID_CONFIGURATION', retryable: false },
      { code: 'note-too-large', expected: 'INVALID_CONFIGURATION', retryable: false },
      { code: 'version-conflict', expected: 'BACKEND_BUSY', retryable: true },
      { code: 'unannounced-refusal', expected: 'INTERNAL_ERROR', retryable: false },
    ] as const

    for (const refusal of refusals) {
      const client = transport(() => ({
        ok: true,
        value: { ok: false, error: { code: refusal.code } },
      }))
      const repository = new Rc6MessageFeedbackRepository(client)

      await expect(repository.put('s1', 'm1', 'positive')).rejects.toMatchObject({
        code: refusal.expected,
        retryable: refusal.retryable,
        context: { rpcMethod: 'messageFeedback/put', rpcCode: refusal.code },
      })
    }
  })
})
