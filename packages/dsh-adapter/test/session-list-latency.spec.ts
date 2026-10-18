import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'

describe('session list upstream reads', () => {
  it('reads the session catalog and workspace snapshot together and still applies archive ownership', async () => {
    let finish!: (value: unknown) => void
    const calls: string[] = []
    const request: DshTransport['request'] = async <T>(method: string): Promise<T> => {
      calls.push(method)
      const value =
        method === 'session.list'
          ? await new Promise((resolve) => {
              finish = resolve
            })
          : {
              items: [
                {
                  workspaceId: 'w1',
                  title: 'Project',
                  path: '/project',
                  sessionIds: ['s1', 's2'],
                  createdAt: '',
                  updatedAt: '',
                },
              ],
              archivedSessionIds: ['s2'],
            }
      return { result: { ok: true, value } } as T
    }
    const transport: DshTransport = {
      request,
      remoteRequest: <T>() => Promise.reject<T>(new Error('Unexpected Remote')),
      openEventStream: async function* () {},
      close: async () => {},
    }
    const repository = new Rc6SessionRepository(transport, new Rc6WorkspaceRepository(transport))
    const pending = repository.list({ archived: false })
    try {
      expect(calls).toEqual(['session.list', 'workspace.list'])
    } finally {
      finish({
        items: ['s1', 's2'].map((sessionId) => ({
          sessionId,
          title: 'Chat',
          blank: false,
          running: false,
          updatedAt: 1700000000000,
        })),
      })
    }
    expect((await pending).items.map(({ id, workspaceId }) => ({ id, workspaceId }))).toEqual([
      { id: 's1', workspaceId: 'w1' },
    ])
  })
})
