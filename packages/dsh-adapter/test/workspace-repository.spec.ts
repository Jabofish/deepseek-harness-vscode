import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'

interface Call {
  readonly method: string
  readonly params: unknown
}

function transportFor(responses: Readonly<Record<string, unknown>>, calls: Call[] = []): DshTransport {
  return {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      const response = responses[method]
      if (response === undefined) return Promise.reject(new Error(`unexpected RPC ${method}`))
      return Promise.resolve({ result: { ok: true, value: response } } as TResponse)
    },
    remoteRequest: <TResponse>() =>
      Promise.reject<TResponse>(new Error('the Remote carrier is not part of this contract')),
    openEventStream: async function* () {
      /* fixture */
    },
    close: () => Promise.resolve(),
  }
}

const WORKSPACE = {
  workspaceId: 'w1',
  path: '/workspace',
  title: 'Workspace',
  sessionIds: ['s1', 's2'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('Rc6WorkspaceRepository ordering', () => {
  it('moves a workspace before an anchor and supports append payloads', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertBefore': { workspaceIds: ['w2', 'w1'] } }, calls),
    )

    await repository.insertBefore('w2', 'w1')
    await repository.insertBefore('w1')

    expect(calls).toEqual([
      { method: 'workspace.insertBefore', params: { workspaceId: 'w2', beforeWorkspaceId: 'w1' } },
      { method: 'workspace.insertBefore', params: { workspaceId: 'w1' } },
    ])
  })

  it('maps the full workspace response for a session move', async () => {
    const calls: Call[] = []
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertSessionBefore': { workspace: WORKSPACE } }, calls),
    )

    await repository.insertSessionBefore('w1', 's2', 's1')

    expect(calls).toEqual([
      {
        method: 'workspace.insertSessionBefore',
        params: { workspaceId: 'w1', sessionId: 's2', beforeSessionId: 's1' },
      },
    ])
  })

  it('rejects malformed ordering responses', async () => {
    const repository = new Rc6WorkspaceRepository(
      transportFor({ 'workspace.insertBefore': { workspaceIds: [''] } }),
    )

    await expect(repository.insertBefore('w1')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
