// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const summary = {
  id: 'session-search',
  workspaceId: 'workspace-search',
  title: 'Search fixture',
  blank: false,
  status: 'completed',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
} as const

function open(response: unknown): {
  readonly request: ReturnType<typeof vi.fn>
  readonly store: ReturnType<typeof createAppStore>
} {
  const request = vi.fn((_request: WebviewRequest) => Promise.resolve(response))
  const client = {
    request,
    subscribe: (_listener: (message: HostMessage) => void) => () => undefined,
    dispose: () => undefined,
  }
  return { request, store: createAppStore(client as unknown as ProtocolClient) }
}

describe('AppStore content session search', () => {
  it('preserves the host bounded-search signal and requests the trimmed query', async () => {
    const { request, store } = open({ items: [summary], searchHasMore: true })

    await expect(store.searchSessions('  needle  ')).resolves.toMatchObject({
      items: [summary],
      searchHasMore: true,
    })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'session.list',
        payload: { search: 'needle', archived: false },
      }),
    )
    store.dispose()
  })

  it.each([
    { response: { items: [summary], searchHasMore: false }, expected: false },
    { response: { items: [summary] }, expected: undefined },
  ])(
    'does not invent more-result metadata when the host reports $expected',
    async ({ response, expected }) => {
      const { store } = open(response)

      await expect(store.searchSessions('needle')).resolves.toMatchObject({
        items: [summary],
        ...(expected === undefined ? {} : { searchHasMore: expected }),
      })
      store.dispose()
    },
  )

  it('rejects malformed search completeness metadata instead of presenting it as complete', async () => {
    const { store } = open({ items: [summary], searchHasMore: 'true' })

    await expect(store.searchSessions('needle')).rejects.toThrow('Malformed session search response.')
    store.dispose()
  })
})
