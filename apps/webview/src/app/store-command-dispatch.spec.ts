// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }
}

const session = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  title: 'Session',
  blank: false,
  status: 'running',
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
} as const

function response(request: WebviewRequest): unknown {
  switch (request.type) {
    case 'session.open':
      return {
        ...session,
        history: [],
        permissionPresets: ['workspace-write'],
        configuration: {
          preset: 'standard',
          toolMode: 'native',
          permissionPreset: 'workspace-write',
          planMode: false,
          model: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        },
      }
    case 'subagent.list':
      return { entries: [], parentAvailable: true }
    case 'models.session.list':
      return { models: [], failures: [] }
    default:
      return []
  }
}

function sentPrompts(client: FakeClient): readonly Extract<WebviewRequest, { type: 'session.sendPrompt' }>[] {
  return client.requests.filter(
    (request): request is Extract<WebviewRequest, { type: 'session.sendPrompt' }> =>
      request.type === 'session.sendPrompt',
  )
}

describe('AppStore command dispatch', () => {
  it('submits a slash line no DSH command answers as a prompt gesture', async () => {
    // `/dsh-badge add a badge` is how a user-invocable skill is addressed. The
    // host answers `undefined` for anything outside its command directory, and
    // the line has to reach the model as an ordinary turn: the host injects the
    // skill through its own gesture.
    const client = new FakeClient((request) =>
      request.type === 'command.execute' ? { kind: 'unknown' } : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    await store.sendPrompt(
      session.id,
      '/dsh-badge add a badge',
      [{ uri: 'attachment-1', name: 'shot.png' }],
      'queue',
    )

    expect(client.requests.filter((request) => request.type === 'command.execute').length).toBe(1)
    const prompts = sentPrompts(client)
    expect(prompts.map((request) => request.payload.text)).toEqual(['/dsh-badge add a badge'])
    expect(prompts[0]?.payload.attachments).toEqual([{ uri: 'attachment-1', name: 'shot.png' }])
    store.dispose()
  })

  it('keeps a command the host rejects as a failure instead of prompting the model', async () => {
    const client = new FakeClient((request) =>
      request.type === 'command.execute'
        ? { kind: 'error', text: 'compact is unavailable' }
        : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    await expect(store.sendPrompt(session.id, '/compact', [], 'queue')).rejects.toThrow(
      'compact is unavailable',
    )
    expect(sentPrompts(client)).toEqual([])
    store.dispose()
  })

  it('submits a picked command no DSH command answers as a prompt gesture', async () => {
    // The palette hands the picked line to the command surface; a skill row has
    // no host command behind it, so the same line has to become the prompt.
    const client = new FakeClient((request) =>
      request.type === 'command.execute' ? { kind: 'unknown' } : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    await expect(store.executeCommand(session.id, '/dsh-badge')).resolves.toBe(true)
    expect(sentPrompts(client).map((request) => request.payload.text)).toEqual(['/dsh-badge'])
    store.dispose()
  })

  it('keeps a picked command that DSH executes out of the prompt path', async () => {
    const client = new FakeClient((request) =>
      request.type === 'command.execute' ? { kind: 'success' } : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    await expect(store.executeCommand(session.id, '/compact', [])).resolves.toBe(true)
    expect(sentPrompts(client)).toEqual([])
    store.dispose()
  })
})
