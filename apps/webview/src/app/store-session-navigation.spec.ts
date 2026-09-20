// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

function session(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: 'workspace',
    title: id,
    blank: false,
    status: 'idle',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    history: [],
    permissionPresets: ['workspace-write'],
    configuration: {
      preset: 'standard',
      toolMode: 'native',
      permissionPreset: 'workspace-write',
      planMode: false,
      model: { providerId: 'provider', modelId: 'model' },
    },
  }
}

describe('session removal navigation', () => {
  it.each(['removeSession', 'deleteSession'] as const)(
    '%s preserves a newer session selection',
    async (operation) => {
      let finish: () => void = () => {
        throw new Error('Mutation not requested')
      }
      const opened: string[] = []
      const client = {
        subscribe: () => () => {},
        dispose: () => {},
        request: async (request: WebviewRequest) => {
          if (request.type === 'session.open') {
            opened.push(request.payload.sessionId)
            return session(request.payload.sessionId)
          }
          if (request.type === 'session.archive' || request.type === 'session.remove') {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            return {}
          }
          if (request.type === 'session.list') return { items: [session('replacement'), session('new')] }
          if (request.type === 'subagent.list') return { entries: [], parentAvailable: true }
          if (request.type === 'models.session.list') return { models: [], failures: [], routable: true }
          return []
        },
      }
      const store = createAppStore(client as unknown as ProtocolClient)
      try {
        await store.openSession('old')
        const mutation = store[operation]('old')
        await store.openSession('new')
        finish()
        await mutation
        expect(opened).toEqual(['old', 'new'])
        expect(store.activeSessionId).toBe('new')
        expect(store.timeline.sessionId).toBe('new')
      } finally {
        store.dispose()
      }
    },
  )
})

describe('created session navigation', () => {
  it.each([
    ['create', true, false],
    ['fork', true, false],
    ['create', false, false],
    ['fork', false, false],
    ['fork', true, true],
    ['fork', false, true],
  ] as const)(
    '%s respects newer navigation: %s, rename failure: %s',
    async (operation, switchSession, renameFails) => {
      let finish: () => void = () => {
        throw new Error('Creation not requested')
      }
      let created = false
      const client = {
        subscribe: () => () => {},
        dispose: () => {},
        request: async (request: WebviewRequest) => {
          if (request.type === 'session.open') return session(request.payload.sessionId)
          if (request.type === 'session.create' || request.type === 'session.fork') {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            created = true
            return session('created')
          }
          if (request.type === 'session.list')
            return { items: [session('old'), session('new'), ...(created ? [session('created')] : [])] }
          if (request.type === 'session.rename' && renameFails) throw new Error('Rename failed')
          if (request.type === 'subagent.list') return { entries: [], parentAvailable: true }
          if (request.type === 'models.session.list') return { models: [], failures: [], routable: true }
          return []
        },
      }
      const store = createAppStore(client as unknown as ProtocolClient)
      try {
        await store.openSession('old')
        const creation = operation === 'create' ? store.createSession() : store.forkSession('old')
        if (switchSession) await store.openSession('new')
        finish()
        if (renameFails) await expect(creation).rejects.toThrow('Rename failed')
        else await creation
        expect(store.activeSessionId).toBe(switchSession ? 'new' : 'created')
        expect(store.sessions.some((entry) => entry.id === 'created')).toBe(true)
      } finally {
        store.dispose()
      }
    },
  )
})
