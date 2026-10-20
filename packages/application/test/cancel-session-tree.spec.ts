import { describe, expect, it, vi } from 'vitest'
import { AppError, type DshBackend, type SubagentCatalog, type SubagentView } from '@dsh-vscode/domain'
import { cancelSessionTree } from '../src/use-cases/cancel-session-tree.js'
import { SessionUseCases } from '../src/use-cases/session-use-cases.js'
import type { BackendService } from '../src/services/backend-service.js'

function child(id: string, parentSessionId: string, overrides: Partial<SubagentView> = {}): SubagentView {
  return {
    kind: 'child',
    id,
    parentSessionId,
    mode: 'continuable',
    activity: 'running',
    hasChildren: false,
    ...overrides,
  }
}
function fixture(catalogs: Record<string, readonly SubagentView[]> = {}): {
  readonly backend: DshBackend
  readonly cancel: ReturnType<typeof vi.fn<(id: string, signal?: AbortSignal) => Promise<void>>>
  readonly interrupt: ReturnType<typeof vi.fn<(id: string, signal?: AbortSignal) => Promise<void>>>
  readonly list: ReturnType<typeof vi.fn<(id: string) => Promise<SubagentCatalog>>>
} {
  const cancel = vi.fn<(id: string, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined)
  const interrupt = vi.fn<(id: string, signal?: AbortSignal) => Promise<void>>().mockResolvedValue(undefined)
  const list = vi.fn((id: string): Promise<SubagentCatalog> =>
    Promise.resolve({ parentAvailable: true, entries: catalogs[id] ?? [] }),
  )
  const backend = { sessions: { cancel }, subagents: { list, interrupt } } as unknown as DshBackend
  return { backend, cancel, interrupt, list }
}

describe('session stop descendants', () => {
  it('uses descendant stopping through the public session cancel use case', async () => {
    const { backend, interrupt } = fixture({ root: [child('child', 'root')] })
    const service = { requireBackend: () => backend } as unknown as BackendService
    await new SessionUseCases(service).cancel('root')
    expect(interrupt).toHaveBeenCalledWith('child', undefined)
  })
  it('signals the root before waiting for any catalog and preserves pending input', async () => {
    const { backend, cancel, list } = fixture()
    let finish!: (value: SubagentCatalog) => void
    list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const stopping = cancelSessionTree(backend, 'root', () => true)
    expect(cancel).toHaveBeenCalledWith('root', undefined)
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith('root', undefined))
    finish({ parentAvailable: true, entries: [] })
    await stopping
  })
  it('stops children and grandchildren including descendants of an idle child', async () => {
    const { backend, interrupt, list } = fixture({
      root: [
        child('live', 'root', { hasChildren: true }),
        child('idle', 'root', { activity: 'inactive', hasChildren: true }),
      ],
      live: [child('grandchild', 'live')],
      idle: [child('idle-grandchild', 'idle')],
    })
    const signal = new AbortController().signal
    await cancelSessionTree(backend, 'root', () => true, signal)
    expect(interrupt.mock.calls).toEqual([
      ['live', signal],
      ['grandchild', signal],
      ['idle-grandchild', signal],
    ])
    expect(list.mock.calls).toEqual([
      ['root', signal],
      ['live', signal],
      ['idle', signal],
    ])
  })
  it('continues stopping siblings when one child fails and exposes the partial stop', async () => {
    const { backend, cancel, interrupt } = fixture({
      root: [child('first', 'root'), child('second', 'root')],
    })
    interrupt.mockRejectedValueOnce(new Error('unavailable'))
    await expect(cancelSessionTree(backend, 'root', () => true)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      retryable: true,
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(interrupt.mock.calls).toEqual([
      ['first', undefined],
      ['second', undefined],
    ])
  })
  it('still interrupts known children if the parent stop fails, and preserves that failure', async () => {
    const { backend, cancel, interrupt } = fixture({ root: [child('child', 'root')] })
    const failure = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'Parent unavailable',
      retryable: true,
    })
    cancel.mockRejectedValue(failure)
    await expect(cancelSessionTree(backend, 'root', () => true)).rejects.toBe(failure)
    expect(interrupt).toHaveBeenCalledWith('child', undefined)
  })
  it('does not start more control calls after cancellation during a child stop', async () => {
    const { backend, interrupt } = fixture({ root: [child('first', 'root'), child('second', 'root')] })
    const controller = new AbortController()
    interrupt.mockImplementationOnce(() => {
      controller.abort()
      return Promise.resolve()
    })
    await expect(cancelSessionTree(backend, 'root', () => true, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })
  it('does not claim unsupported live children were stopped or route them as ordinary sessions', async () => {
    const { backend, cancel, interrupt } = fixture({
      root: [child('one-shot', 'root', { mode: 'one-shot' })],
    })
    await expect(cancelSessionTree(backend, 'root', () => true)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(cancel.mock.calls).toEqual([['root', undefined]])
    expect(interrupt).not.toHaveBeenCalled()
  })
  it('keeps ordinary Stop working when the composition has no subagent capability', async () => {
    const { backend, list, cancel } = fixture()
    list.mockRejectedValue(
      new AppError({ code: 'CAPABILITY_UNAVAILABLE', message: 'Not composed', retryable: false }),
    )
    await cancelSessionTree(backend, 'root', () => true)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('does not send child controls after the connection changes during a read', async () => {
    const { backend, interrupt, list } = fixture()
    let current = true
    list.mockImplementation(() => {
      current = false
      return Promise.resolve({ parentAvailable: true, entries: [child('other', 'root')] })
    })
    await expect(cancelSessionTree(backend, 'root', () => current)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(interrupt).not.toHaveBeenCalled()
  })
  it('rejects cycles and foreign parent addresses without controlling unrelated work', async () => {
    const { backend, interrupt } = fixture({ root: [child('root', 'root'), child('foreign', 'elsewhere')] })
    await expect(cancelSessionTree(backend, 'root', () => true)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    })
    expect(interrupt).not.toHaveBeenCalled()
  })
})
