// @vitest-environment jsdom

import { useSyncExternalStore, type ReactElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AppError, type SessionSummary, type WorkspaceRepository } from '@dsh-vscode/domain'
import type { FeatureHostMessage, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import { ProtocolClient } from '../../app/protocol-client.js'
import { createAppStore, type AppStore } from '../../app/store.js'
import { SessionDrawer } from './SessionDrawer.js'

const titles = ['Alpha conversation', 'Beta conversation', 'Gamma conversation', 'Delta conversation']
const time = '2026-01-01T00:00:00.000Z'
const disposables: Array<() => void> = []
afterEach(() => {
  cleanup()
  for (const dispose of disposables.splice(0)) dispose()
})

interface Fixture {
  readonly store: AppStore
  readonly mount: () => ReturnType<typeof render>
  readonly refuseMove: () => void
}

async function fixture(blank = false, searchable = false): Promise<Fixture> {
  const { WebviewMessageRouter } = await vi.importActual<{
    WebviewMessageRouter: new (deps: {
      postMessage(message: HostMessage | FeatureHostMessage): Promise<boolean>
      handleRequest(request: WebviewRequest, signal: AbortSignal): Promise<unknown>
    }) => { handle(message: unknown, surfaceId: string): Promise<void>; cancelAll(): void }
  }>('../../../../extension/src/view/message-router.js')
  const { Rc6WorkspaceRepository } = await vi.importActual<{
    Rc6WorkspaceRepository: new (transport: unknown) => WorkspaceRepository
  }>('../../../../../packages/dsh-adapter/src/repositories/workspace-repository.js')
  let workspaces = [
    {
      workspaceId: 'w1',
      title: 'One',
      path: '/fixture/one',
      createdAt: time,
      updatedAt: time,
      sessionIds: ['a', 'b', 'c'],
    },
    {
      workspaceId: 'w2',
      title: 'Two',
      path: '/fixture/two',
      createdAt: time,
      updatedAt: time,
      sessionIds: ['d'],
    },
  ]
  const sessions: readonly SessionSummary[] = ['a', 'b', 'c', 'd'].map((id, index) => ({
    id,
    workspaceId: id === 'd' ? 'w2' : 'w1',
    title: `${titles[index]!}${searchable ? (id === 'b' || id === 'd' ? ' hidden' : ' match') : ''}`,
    blank: blank && id === 'a',
    status: 'completed',
    createdAt: time,
    updatedAt: time,
  }))
  let refuseNextMove = false
  const repository = new Rc6WorkspaceRepository({
    // Synthetic DSH wire: ordering is durable here, outside the rendered Store.
    request: (
      method: string,
      payload: { workspaceId: string; sessionId: string; beforeSessionId?: string },
    ) => {
      if (method === 'workspace.list')
        return Promise.resolve({ result: { ok: true, value: { items: workspaces, archivedSessionIds: [] } } })
      if (method !== 'workspace.insertSessionBefore') throw new Error(`Unexpected RPC: ${method}`)
      if (refuseNextMove) {
        refuseNextMove = false
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Move refused. Please retry.',
          retryable: true,
        })
      }
      const workspace = workspaces.find((item) => item.workspaceId === payload.workspaceId)!
      const remaining = workspace.sessionIds.filter((id) => id !== payload.sessionId)
      const index =
        payload.beforeSessionId === undefined ? remaining.length : remaining.indexOf(payload.beforeSessionId)
      const moved = {
        ...workspace,
        sessionIds: [...remaining.slice(0, index), payload.sessionId, ...remaining.slice(index)],
      }
      workspaces = workspaces.map((item) => (item === workspace ? moved : item))
      return Promise.resolve({ result: { ok: true, value: { workspace: moved } } })
    },
  })
  const router = new WebviewMessageRouter({
    postMessage: (message) => {
      window.dispatchEvent(new MessageEvent('message', { data: { protocolVersion: 1, message } }))
      return Promise.resolve(true)
    },
    handleRequest: async (request, signal) => {
      if (request.type === 'session.list')
        return { items: sessions.filter((session) => session.title.includes(request.payload.search ?? '')) }
      if (request.type === 'workspace.list')
        return {
          items: (await repository.list(signal)).map(({ path: _path, ...workspace }) => workspace),
          archivedSessionIds: [],
        }
      if (request.type === 'session.move')
        return repository.insertSessionBefore(
          request.payload.workspaceId,
          request.payload.sessionId,
          request.payload.beforeSessionId,
          signal,
        )
      return []
    },
  })
  const store = createAppStore(
    new ProtocolClient({
      getState: () => undefined,
      setState: () => undefined,
      postMessage: (message) => {
        void router.handle(message, 'sidebar')
      },
    }),
  )
  disposables.push(() => {
    store.dispose()
    router.cancelAll()
  })
  await store.refreshSessions()
  function Drawer(): ReactElement {
    const state = useSyncExternalStore(
      (listener) => store.subscribe(listener),
      () => store.getState(),
    )
    return (
      <SessionDrawer
        sessions={state.sessions}
        workspaces={state.workspaces}
        activeSessionId="a"
        open
        showTrigger={false}
        archivedSessions={[]}
        onMoveSession={(...args) => store.moveSession(...args)}
        onMoveWorkspace={(...args) => store.moveWorkspace(...args)}
        onOpen={() => undefined}
        onCreate={() => undefined}
        onArchive={(...args) => store.removeSession(...args)}
        onLoadArchived={() => store.loadArchivedSessions()}
        onRestore={(...args) => store.restoreSession(...args)}
        onDelete={(...args) => store.deleteSession(...args)}
        onRename={(...args) => store.renameSession(...args)}
        onRenameWorkspace={(...args) => store.renameWorkspace(...args)}
        onAddWorkspace={() => store.addWorkspaceFolder()}
        onRemoveWorkspace={(...args) => store.removeWorkspace(...args)}
        onSearch={(...args) => store.searchSessions(...args)}
      />
    )
  }
  return {
    store,
    mount: () => render(<Drawer />),
    refuseMove: () => {
      refuseNextMove = true
    },
  }
}

function row(title: string): HTMLElement {
  const item = screen
    .getByRole('button', { name: new RegExp(`^(?!Session actions).*${title}`, 'u') })
    .closest('li')
  if (item === null) throw new Error(`Missing conversation: ${title}`)
  return item
}

function drag(source: string, target?: string): void {
  const values = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: '',
    dropEffect: 'none',
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
  }
  const sourceRow = row(source)
  fireEvent.dragStart(sourceRow, { dataTransfer })
  if (target !== undefined) {
    fireEvent.dragOver(row(target), { dataTransfer })
    fireEvent.drop(row(target), { dataTransfer })
  }
  fireEvent.dragEnd(sourceRow, { dataTransfer })
}

function visibleOrder(): readonly string[] {
  return screen
    .getAllByRole('button', { name: /^(?!Session actions).*(Alpha|Beta|Gamma|Delta) conversation/u })
    .map((button) => titles.find((title) => button.textContent?.includes(title))!)
}

it.each([false, true])(
  'saves downward and upward row drops, including the end, grouped=%s',
  async (grouped) => {
    const f = await fixture()
    const view = f.mount()
    if (grouped) fireEvent.click(screen.getByRole('button', { name: 'Show grouped workspaces' }))
    const other = grouped ? [titles[3]] : []
    drag(titles[0]!, titles[1])
    await waitFor(() => expect(visibleOrder()).toEqual([titles[1], titles[0], titles[2], ...other]))
    drag(titles[0]!, titles[2])
    await waitFor(() => expect(visibleOrder()).toEqual([titles[1], titles[2], titles[0], ...other]))
    await act(() => f.store.refreshSessions())
    expect(visibleOrder()).toEqual([titles[1], titles[2], titles[0], ...other])
    view.unmount()
    f.mount()
    expect(visibleOrder()).toEqual([titles[1], titles[2], titles[0]])
    drag(titles[0]!, titles[1])
    await waitFor(() => expect(visibleOrder()).toEqual(titles.slice(0, 3)))
  },
)

it('leaves cancelled and cross-workspace drops unchanged', async () => {
  const f = await fixture()
  f.mount()
  fireEvent.click(screen.getByRole('button', { name: 'Show grouped workspaces' }))
  drag(titles[0]!)
  drag(titles[0]!, titles[3])
  await act(() => f.store.refreshSessions())
  expect(visibleOrder()).toEqual(titles)
})

it('reports a refused move, preserves the order and allows retry', async () => {
  const f = await fixture()
  f.mount()
  f.refuseMove()
  drag(titles[0]!, titles[1])
  expect((await screen.findByRole('alert')).textContent).toContain('The operation is not permitted.')
  expect(visibleOrder()).toEqual(titles.slice(0, 3))
  drag(titles[0]!, titles[1])
  await waitFor(() => expect(visibleOrder()).toEqual([titles[1], titles[0], titles[2]]))
  expect(screen.queryByRole('alert')).toBeNull()
})

it('keeps the current blank session first while rearranging completed conversations', async () => {
  const f = await fixture(true)
  f.mount()
  drag(titles[1]!, titles[2])
  await waitFor(() => expect(visibleOrder()).toEqual([titles[0], titles[2], titles[1]]))
  drag(titles[0]!, titles[1])
  drag(titles[1]!, titles[0])
  await act(() => f.store.refreshSessions())
  expect(visibleOrder()).toEqual([titles[0], titles[2], titles[1]])
})

it('preserves hidden conversations when rearranging a filtered list', async () => {
  const f = await fixture(false, true)
  f.mount()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'match' } })
  expect(visibleOrder()).toEqual([titles[0], titles[2]])
  drag(titles[0]!, titles[2])
  await waitFor(() => expect(visibleOrder()).toEqual([titles[2], titles[0]]))
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
  expect(visibleOrder()).toEqual([titles[1], titles[2], titles[0]])
})

it('does not rearrange a list sorted by last updated', async () => {
  const f = await fixture()
  f.mount()
  fireEvent.click(screen.getByRole('button', { name: 'Sort sessions by last updated' }))
  drag(titles[0]!, titles[1])
  fireEvent.click(screen.getByRole('button', { name: 'Sort sessions by manual order' }))
  await act(() => f.store.refreshSessions())
  expect(visibleOrder()).toEqual(titles.slice(0, 3))
})
