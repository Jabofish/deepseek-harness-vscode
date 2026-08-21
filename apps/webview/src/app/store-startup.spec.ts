// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class StartupClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(startupResponse(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

const activeSession = {
  id: 'session-active',
  workspaceId: 'workspace-1',
  title: 'Existing active conversation',
  blank: false,
  status: 'running',
  createdAt: '2026-08-21T08:00:00.000Z',
  updatedAt: '2026-08-21T08:05:00.000Z',
} as const

function startupResponse(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'app.ready':
    case 'runtime.update.check':
    case 'settings.read':
      return request.type === 'runtime.update.check'
        ? {
            status: 'ready',
            availableVersions: ['0.1.0-rc.8'],
            updateAvailable: false,
            checkedAt: '2026-08-21T00:00:00.000Z',
          }
        : undefined
    case 'session.list':
      return { items: [activeSession] }
    case 'workspace.list':
      return { items: [] }
    case 'providers.list':
    case 'models.list':
      return []
    case 'preset.list':
      return { presets: [] }
    case 'session.open':
      return {
        ...activeSession,
        history: [],
        permissionPresets: ['workspace-write', 'danger-full-access'],
        configuration: {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        },
      }
    case 'session.queue.list':
    case 'goal.list':
    case 'job.list':
    case 'feedback.list':
    case 'command.list':
    case 'skill.list':
    case 'subagent.list':
      return request.type === 'subagent.list' ? { entries: [], parentAvailable: true } : []
    case 'models.session.list':
      return { models: [] }
    default:
      throw new Error(`unexpected startup request ${request.type}`)
  }
}

describe('AppStore startup session restoration', () => {
  afterEach(() => document.body.replaceChildren())

  it('opens an existing active root session when no persisted id is available', async () => {
    const client = new StartupClient()
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.initialize()

    expect(store.activeSessionId).toBe('session-active')
    expect(store.configuration).toMatchObject({
      permissionPreset: 'workspace-write',
      planMode: false,
    })
    expect(client.requests.filter((request) => request.type === 'session.open')).toHaveLength(1)
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'runtime.update.check',
        payload: { force: false },
      }),
    )
    expect(client.requests).toContainEqual(
      expect.objectContaining({
        type: 'session.open',
        payload: { sessionId: 'session-active' },
      }),
    )

    store.dispose()
  })
})
