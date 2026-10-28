// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

class FakeClient {
  public readonly requests: WebviewRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest, signal?: AbortSignal) => unknown) {}

  public request<T>(request: WebviewRequest, signal?: AbortSignal): Promise<T> {
    this.requests.push(request)
    return Promise.resolve(this.answer(request, signal) as T)
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
      return {
        models: [],
        failures: [],
        current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        routable: true,
      }
    default:
      return undefined
  }
}

describe('AppStore prompt admission', () => {
  describe('queue reread ordering', () => {
    const queued = {
      id: 'queued-input',
      sessionId: session.id,
      text: 'still waiting',
      attachments: [],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: session.createdAt,
    }

    it('rejects malformed rows and rows belonging to another conversation', async () => {
      let listed: unknown = undefined
      const client = new FakeClient((request) =>
        request.type === 'session.queue.list' ? listed : response(request),
      )
      const store = createAppStore(client as unknown as ProtocolClient)
      await store.openSession(session.id)
      await vi.waitFor(() => expect(store.getState().unavailableLists).toContain('queue'))
      listed = [queued]
      expect(await store.refreshQueue(session.id)).toEqual([queued])
      expect(store.getState().unavailableLists).not.toContain('queue')
      listed = [{ ...queued, sessionId: 'another-session' }]
      expect(await store.refreshQueue(session.id)).toBeUndefined()
      listed = [{ id: queued.id }]
      expect(await store.refreshQueue(session.id)).toBeUndefined()
      expect(store.queue).toEqual([queued])
      store.dispose()
    })
  })

  it('records direct-send identity before the RPC and leaves the draft as its only local preview', async () => {
    const requestDone = deferred<void>()
    const client = new FakeClient((request) =>
      request.type === 'session.sendPrompt'
        ? requestDone.promise
        : request.type === 'session.open'
          ? { ...(response(request) as object), status: 'idle' }
          : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)
    const sending = store.sendPrompt(session.id, 'direct prompt', [], 'queue')
    const request = client.requests.find((entry) => entry.type === 'session.sendPrompt')
    expect(store.getState().directPromptRequestIds).toEqual([request?.requestId])
    expect(store.timeline.nodes).toEqual([])
    requestDone.resolve()
    await sending
    expect(store.timeline.nodes).toEqual([])
    store.dispose()
  })

  it('does not apply partial goal, todo, or queue snapshots when a row is malformed', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    const goal = { id: 'goal-1', title: 'Bounded work', status: 'in-progress' as const }
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 1,
      payload: { sessionId: session.id, goals: [goal] },
    })
    await Promise.resolve()
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 2,
      payload: {
        sessionId: session.id,
        goals: [
          { ...goal, title: 'Would be partially applied' },
          { id: 'goal-2', title: 'Broken', status: 'future' },
        ],
      },
    })
    await Promise.resolve()
    expect(store.goals).toEqual([goal])

    const todo = { id: 'todo-1', content: 'Keep this row', status: 'pending' as const }
    client.emit({
      type: 'event',
      name: 'todo.updated',
      sequence: 3,
      payload: { sessionId: session.id, todos: [todo] },
    })
    await Promise.resolve()
    client.emit({
      type: 'event',
      name: 'todo.updated',
      sequence: 4,
      payload: {
        sessionId: session.id,
        todos: [
          { ...todo, content: 'Would be partially applied' },
          { id: 'todo-2', content: 'Broken', status: 'future' },
        ],
      },
    })
    await Promise.resolve()
    expect(store.todos).toEqual([todo])

    const queued = {
      id: 'queue-1',
      sessionId: session.id,
      text: 'Keep this queue item',
      attachments: [],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: '2026-08-31T00:00:01.000Z',
    }
    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 5,
      payload: { sessionId: session.id, items: [queued] },
    })
    await Promise.resolve()
    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 6,
      payload: {
        sessionId: session.id,
        items: [
          { ...queued, text: 'Would be partially applied' },
          { ...queued, id: 'queue-2', mode: 'bad' },
        ],
      },
    })
    await Promise.resolve()
    expect(store.queue).toEqual([queued])
    store.dispose()
  })

  it('does not apply partial permission or question requests when nested data is malformed', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    const permission = {
      id: 'approval-1',
      sessionId: session.id,
      title: 'Allow the command?',
      description: 'The command needs approval.',
      risk: 'medium' as const,
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' as const }],
    }
    client.emit({
      type: 'event',
      name: 'permission.requested',
      sequence: 1,
      payload: { request: permission },
    })
    await Promise.resolve()
    expect(store.permissions).toEqual([permission])

    client.emit({
      type: 'event',
      name: 'permission.requested',
      sequence: 2,
      payload: {
        request: {
          ...permission,
          title: 'Would be partially applied',
          options: [permission.options[0], { id: 'broken', label: 'Broken', kind: 'future' }],
        },
      },
    })
    await Promise.resolve()
    expect(store.permissions).toEqual([permission])

    const question = {
      id: 'question-1',
      sessionId: session.id,
      prompt: 'Choose a plan',
      choices: [{ id: 'yes', label: 'Yes' }],
      allowFreeText: false,
    }
    client.emit({
      type: 'event',
      name: 'question.requested',
      sequence: 3,
      payload: { question },
    })
    await Promise.resolve()
    expect(store.questions).toEqual([question])

    client.emit({
      type: 'event',
      name: 'question.requested',
      sequence: 4,
      payload: {
        question: {
          ...question,
          prompt: 'Would be partially applied',
          choices: [question.choices[0], { id: 'broken', label: 3 }],
        },
      },
    })
    await Promise.resolve()
    expect(store.questions).toEqual([question])
    store.dispose()
  })

  it('applies live permission and question resolutions instead of treating them as unknown events', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    const permission = {
      id: 'approval-live',
      sessionId: session.id,
      title: 'Allow the command?',
      description: 'The command needs approval.',
      risk: 'medium' as const,
      options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' as const }],
    }
    const question = {
      id: 'question-live',
      sessionId: session.id,
      prompt: 'Choose a plan',
      choices: [{ id: 'yes', label: 'Yes' }],
      allowFreeText: false,
    }
    client.emit({
      type: 'event',
      name: 'permission.requested',
      sequence: 1,
      payload: { request: permission },
    })
    client.emit({
      type: 'event',
      name: 'question.requested',
      sequence: 2,
      payload: { question },
    })
    await Promise.resolve()
    expect(store.permissions).toEqual([permission])
    expect(store.questions).toEqual([question])

    client.emit({
      type: 'event',
      name: 'permission.resolved',
      sequence: 3,
      payload: { sessionId: session.id, requestId: permission.id, outcome: 'rejected' },
    })
    client.emit({
      type: 'event',
      name: 'question.resolved',
      sequence: 4,
      payload: { sessionId: session.id, questionId: question.id, outcome: 'answered' },
    })
    await Promise.resolve()
    expect(store.permissions).toEqual([])
    expect(store.questions).toEqual([])
    store.dispose()
  })

  it('rejects unsupported input modalities and keeps the last complete model catalog', async () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', configurable: false, fields: [] }
    const model = {
      id: 'deepseek-chat',
      providerId: 'deepseek',
      label: 'DeepSeek Chat',
      supportsReasoning: false,
    }
    let malformed = false
    const client = new FakeClient((request) => {
      if (request.type === 'providers.list') return [provider]
      if (request.type === 'models.list')
        return [malformed ? { ...model, inputModalities: ['audio'] } : model]
      return response(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshModelCatalog()
    const lastCompleteModels = store.models
    expect(lastCompleteModels).toEqual([model])

    malformed = true
    await store.refreshModelCatalog()

    expect(store.models).toBe(lastCompleteModels)
    store.dispose()
  })

  it('does not apply a queued snapshot when a nested attachment row is malformed', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    const queued = {
      id: 'queue-1',
      sessionId: session.id,
      text: 'queued with an attachment',
      attachments: [{ uri: 'dsh-attachment:one', name: 'one.txt', mimeType: 'text/plain' }],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: '2026-08-31T00:00:01.000Z',
    }
    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 1,
      payload: { sessionId: session.id, items: [queued] },
    })
    await Promise.resolve()
    expect(store.queue).toEqual([queued])

    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 2,
      payload: {
        sessionId: session.id,
        items: [
          {
            ...queued,
            text: 'must not replace the complete snapshot',
            attachments: [queued.attachments[0], { uri: 'dsh-attachment:broken', name: 3 }],
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.queue).toEqual([queued])
    store.dispose()
  })

  it('keeps a queued row when the admitted message carries different attachments', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    client.emit({
      type: 'event',
      name: 'queue.updated',
      sequence: 1,
      payload: {
        sessionId: session.id,
        items: [
          {
            id: 'queue-image-1',
            sessionId: session.id,
            text: '看这张图',
            attachments: [],
            images: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }],
            textOnly: false,
            mode: 'queue' as const,
            createdAt: '2026-09-16T00:00:00.000Z',
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.queue).toHaveLength(1)

    // Same words, but the durable message carries two images: it is a
    // different submission, so the pending row must survive.
    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 2,
      payload: {
        sessionId: session.id,
        messageId: 'message-1',
        markdown: '看这张图',
        source: 'user',
        images: [
          { attachmentId: 'image-2', mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
          { attachmentId: 'image-3', mediaType: 'image/png', bytes: 4, width: 2, height: 2 },
        ],
      },
    })
    await Promise.resolve()
    expect(store.queue).toHaveLength(1)
    store.dispose()
  })
})
