import { describe, expect, it, vi } from 'vitest'

import type { DshTransport } from '../src/contracts.js'
import type { SessionRepository } from '@dsh-vscode/domain'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { Rc172SessionRepository } from '../src/versions/rc172/session-repository.js'

function repository(remoteRequest: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true })): {
  readonly repository: Rc172SessionRepository
  readonly remoteRequest: ReturnType<typeof vi.fn>
} {
  const transport = { remoteRequest } as unknown as DshTransport
  const workspaces = {} as Rc6WorkspaceRepository
  return { repository: new Rc172SessionRepository(transport, workspaces, undefined, {}), remoteRequest }
}

describe('Rc172SessionRepository.initializeDefaultModel', () => {
  it('keeps the optional operation absent from the base Session Repository used by older profiles', () => {
    const sessions: SessionRepository = new Rc6SessionRepository({} as DshTransport)

    expect(sessions.initializeDefaultModel).toBeUndefined()
  })

  it('calls the pinned no-argument Session Remote and accepts its void result', async () => {
    const active = repository()
    const controller = new AbortController()

    await expect(active.repository.initializeDefaultModel(controller.signal)).resolves.toBeUndefined()
    expect(active.remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'session/initializeDefaultModel',
      {},
      controller.signal,
    )
  })

  it('preserves the upstream no-model error code for Host-only handling', async () => {
    const active = repository(
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'session/provider-models-unavailable', message: 'private server diagnostic' },
      }),
    )

    await expect(active.repository.initializeDefaultModel()).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
      context: { rpcCode: 'session/provider-models-unavailable' },
    })
  })

  it('rejects malformed Remote envelopes instead of treating them as successful initialization', async () => {
    const active = repository(vi.fn().mockResolvedValue({ ok: 'yes' }))

    await expect(active.repository.initializeDefaultModel()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it.each(['unexpected', null])('rejects an unexpected success value %s for a void Remote', async (value) => {
    const active = repository(vi.fn().mockResolvedValue({ ok: true, value }))

    await expect(active.repository.initializeDefaultModel()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })
})
