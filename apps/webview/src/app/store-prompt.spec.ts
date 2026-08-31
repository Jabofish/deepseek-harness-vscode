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

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const session = {
  id: 'session-1',
  workspaceId: 'workspace-1',
  title: 'Session',
  blank: false,
  status: 'running',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
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
      return undefined
  }
}

describe('AppStore prompt admission', () => {
  it('keeps a queued prompt out of the timeline until DSH admits it', async () => {
    const requestDone = deferred<void>()
    const client = new FakeClient((request) =>
      request.type === 'session.sendPrompt' ? requestDone.promise : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    const sending = store.sendPrompt(session.id, 'queued prompt', [], 'queue')
    await Promise.resolve()

    expect(store.timeline.nodes).toEqual([])
    const sendRequest = client.requests.find(
      (request): request is Extract<WebviewRequest, { type: 'session.sendPrompt' }> =>
        request.type === 'session.sendPrompt',
    )
    expect(sendRequest).toBeDefined()
    if (sendRequest === undefined) throw new Error('expected queued prompt request')
    expect(sendRequest.payload).toMatchObject({ sessionId: session.id, text: 'queued prompt', mode: 'queue' })

    const queuedInput = {
      id: 'queue-1',
      sessionId: session.id,
      text: 'queued prompt',
      attachments: [],
      mode: 'queue' as const,
      createdAt: '2026-08-31T00:00:01.000Z',
    }
    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 1,
      payload: { sessionId: session.id, items: [queuedInput] },
    })
    await Promise.resolve()
    expect(store.queue).toEqual([queuedInput])
    expect(store.timeline.nodes).toEqual([])

    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 2,
      payload: { sessionId: session.id, messageId: 'message-1', markdown: 'queued prompt', source: 'user' },
    })
    await Promise.resolve()
    expect(store.timeline.nodes).toEqual([
      { kind: 'user-message', id: 'message-1', markdown: 'queued prompt', source: 'user' },
    ])
    expect(store.queue).toEqual([])

    requestDone.resolve()
    await sending
    store.dispose()
  })
})
