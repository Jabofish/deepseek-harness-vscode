import { describe, expect, it, vi } from 'vitest'

import { AppError, type SessionDetail } from '@dsh-vscode/domain'
import type { DshTransport } from '../src/contracts.js'
import type { SessionRepository } from '@dsh-vscode/domain'
import { Rc6SessionRepository } from '../src/repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../src/repositories/workspace-repository.js'
import { normalizeRc172ErrorCode } from '../src/versions/rc172/error-vocabulary.js'
import { Rc172SessionRepository } from '../src/versions/rc172/session-repository.js'

function repository(remoteRequest: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ ok: true })): {
  readonly repository: Rc172SessionRepository
  readonly remoteRequest: ReturnType<typeof vi.fn>
  readonly request: ReturnType<typeof vi.fn>
} {
  const request = vi.fn().mockResolvedValue({ result: { ok: true, value: undefined } })
  const transport = { request, remoteRequest } as unknown as DshTransport
  const workspaces = {} as Rc6WorkspaceRepository
  return {
    repository: new Rc172SessionRepository(transport, workspaces, undefined, {}),
    remoteRequest,
    request,
  }
}

/** DSH tag `dsh-v0.1.7-rc.2`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`: `SessionSearchValue` in session-controller/src/types.ts; bounded in list.ts. */
function sessionSearchRepository(searchResult: unknown): {
  readonly repository: Rc172SessionRepository
  readonly calls: { readonly method: string; readonly params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  const transport = {
    request: <TResponse>(method: string, params: unknown) => {
      calls.push({ method, params })
      const value =
        method === 'session.list'
          ? {
              items: [
                {
                  sessionId: 'session-a',
                  workspaceId: 'workspace-a',
                  updatedAt: 1,
                  running: false,
                  blank: false,
                },
              ],
            }
          : method === 'session.search'
            ? searchResult
            : { events: [], hasMore: false }
      return Promise.resolve({ result: { ok: true, value } } as TResponse)
    },
    remoteRequest: vi.fn(),
  }
  return {
    repository: new Rc172SessionRepository(
      transport as unknown as DshTransport,
      undefined as unknown as Rc6WorkspaceRepository,
      undefined,
      {},
    ),
    calls,
  }
}

describe('Rc172SessionRepository content search', () => {
  it('retains the RC2 bounded-result signal through the SessionPage contract', async () => {
    const active = sessionSearchRepository({
      items: [{ sessionId: 'session-a', snippet: 'needle' }],
      hasMore: true,
    })

    const page = await active.repository.list({ search: 'needle' })

    expect(page.items.map((item) => item.id)).toEqual(['session-a'])
    expect(page.searchHasMore).toBe(true)
    expect(active.calls).toEqual([
      { method: 'session.list', params: {} },
      { method: 'session.search', params: { query: 'needle' } },
    ])
  })

  it.each([
    { items: [{ sessionId: 'session-a', snippet: 'needle' }] },
    { items: [{ sessionId: 'session-a', snippet: 'needle' }], hasMore: 'true' },
  ])('rejects malformed RC2 bounded-search metadata: %j', async (searchResult) => {
    const active = sessionSearchRepository(searchResult)

    await expect(active.repository.list({ search: 'needle' })).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })
})

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

  it('selects a preset for a blank session through the rc.2 Agent Preset Remote', async () => {
    const active = repository(vi.fn().mockResolvedValue({ ok: true, value: 'minimal' }))
    vi.spyOn(active.repository, 'get').mockResolvedValue({
      status: 'idle',
      blank: true,
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    } as unknown as SessionDetail)
    const controller = new AbortController()

    await active.repository.setConfiguration(
      'session-1',
      {
        preset: 'minimal',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
      controller.signal,
    )

    expect(active.remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'agentPresets/select',
      { agentId: 'session-1', agentPreset: 'minimal' },
      controller.signal,
    )
    expect(active.request).not.toHaveBeenCalled()
  })

  it('does not call the rc.2 Remote for a completed but idle session', async () => {
    const active = repository()
    vi.spyOn(active.repository, 'get').mockResolvedValue({
      status: 'idle',
      blank: false,
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    } as unknown as SessionDetail)

    await expect(
      active.repository.setConfiguration('session-1', {
        preset: 'minimal',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })

    expect(active.remoteRequest).not.toHaveBeenCalled()
    expect(active.request).not.toHaveBeenCalled()
  })

  it('preserves a racing Remote lock refusal and forwards cancellation for blank-session mode changes', async () => {
    const normalizedLockedCode = normalizeRc172ErrorCode('agent-preset/locked', {})
    const refused = repository(
      vi.fn().mockResolvedValue({
        ok: false,
        error: { code: normalizedLockedCode, message: 'The session has already started.' },
      }),
    )
    const current: SessionDetail = {
      status: 'idle',
      blank: true,
      configuration: {
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    } as unknown as SessionDetail
    vi.spyOn(refused.repository, 'get').mockResolvedValue(current)
    const configuration = {
      preset: 'minimal',
      toolMode: 'native' as const,
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: '', modelId: '' },
    }

    let refusal: unknown
    try {
      await refused.repository.setConfiguration('session-1', configuration)
    } catch (error: unknown) {
      refusal = error
    }
    expect(refusal).toBeInstanceOf(AppError)
    expect((refusal as AppError).code).toBe('INVALID_CONFIGURATION')
    expect((refusal as AppError).message).toMatch(/^The DSH agent preset is locked for this session\./)
    expect((refusal as AppError).message).not.toContain('agent-preset/locked')
    expect((refusal as AppError).context).toMatchObject({
      rpcCode: 'agent-preset-locked',
      rpcMethod: 'agentPresets/select',
    })
    expect(refused.request).not.toHaveBeenCalled()
    expect(refused.remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'agentPresets/select',
      { agentId: 'session-1', agentPreset: 'minimal' },
      undefined,
    )

    const controller = new AbortController()
    const cancelled = repository(
      vi.fn((_endpoint: string, _args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => {
        signal?.throwIfAborted()
        return Promise.resolve({ ok: true, value: 'minimal' })
      }),
    )
    vi.spyOn(cancelled.repository, 'get').mockResolvedValue(current)
    controller.abort()

    await expect(
      cancelled.repository.setConfiguration('session-1', configuration, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(cancelled.remoteRequest).toHaveBeenCalledExactlyOnceWith(
      'agentPresets/select',
      { agentId: 'session-1', agentPreset: 'minimal' },
      controller.signal,
    )
  })

  it('keeps the legacy Host RPC for adapters without the rc.2 preset callback', async () => {
    const request = vi.fn().mockResolvedValue({
      result: { ok: true, value: { agentPreset: 'minimal' } },
    })
    const remoteRequest = vi.fn()
    const legacy = new Rc6SessionRepository({ request, remoteRequest } as unknown as DshTransport)
    vi.spyOn(legacy, 'get').mockResolvedValue({
      status: 'idle',
      blank: false,
      configuration: {
        permissionPresetKnown: true,
        planModeKnown: true,
        preset: 'standard',
        toolMode: 'native',
        permissionPreset: 'workspace-write',
        planMode: false,
        model: { providerId: '', modelId: '' },
      },
    } as unknown as SessionDetail)

    await legacy.setConfiguration('session-1', {
      preset: 'minimal',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: '', modelId: '' },
    })

    expect(request).toHaveBeenCalledExactlyOnceWith(
      'agentPreset.select',
      { sessionId: 'session-1', agentPreset: 'minimal' },
      undefined,
    )
    expect(remoteRequest).not.toHaveBeenCalled()
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
