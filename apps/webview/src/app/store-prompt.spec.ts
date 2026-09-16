// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
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
      return { models: [], failures: [] }
    default:
      return undefined
  }
}

describe('AppStore prompt admission', () => {
  it('preserves the host session-reference workspace relation and ignores malformed rows', async () => {
    const client = new FakeClient((request) =>
      request.type === 'reference.list'
        ? {
            files: [],
            sessions: [
              {
                sessionId: 'source-1',
                label: 'Review',
                sameWorkspace: true,
                createdAt: 10,
                mention: '@[Review](dsh-session:source-1)',
              },
              {
                sessionId: 'source-2',
                label: 'Malformed',
                sameWorkspace: 'yes',
                createdAt: 20,
                mention: '@[Malformed](dsh-session:source-2)',
              },
            ],
          }
        : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(store.listReferences(session.id, '', false)).resolves.toEqual([
      {
        id: 'session:source-1',
        kind: 'session',
        sessionId: 'source-1',
        label: 'Review',
        description: 'source-1',
        mention: '@[Review](dsh-session:source-1)',
        sameWorkspace: true,
      },
    ])
    store.dispose()
  })

  it('sends a goal round-cap-only update', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.updateGoal('goal-1', { maxGoalRounds: 9 })

    const goalUpdate = client.requests.find(
      (request): request is Extract<WebviewRequest, { type: 'goal.update' }> =>
        request.type === 'goal.update',
    )
    if (goalUpdate === undefined) throw new Error('expected goal update request')
    expect(goalUpdate.requestId).toEqual(expect.any(String))
    expect(goalUpdate.payload).toEqual({ goalId: 'goal-1', maxGoalRounds: 9 })
    store.dispose()
  })

  it('retains a goal round cap from live goal events', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 1,
      payload: {
        sessionId: session.id,
        goals: [{ id: 'goal-1', title: 'Bounded work', status: 'in-progress', maxGoalRounds: 9 }],
      },
    })
    await Promise.resolve()

    expect(store.goals).toEqual([
      { id: 'goal-1', title: 'Bounded work', status: 'in-progress', maxGoalRounds: 9 },
    ])
    store.dispose()
  })

  it('retains a goal block reason and rejects a row whose reason is unusable', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)
    await store.openSession(session.id)

    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 1,
      payload: {
        sessionId: session.id,
        goals: [
          {
            id: 'goal-1',
            title: 'Wait for review',
            status: 'blocked',
            blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' },
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.goals).toEqual([
      {
        id: 'goal-1',
        title: 'Wait for review',
        status: 'blocked',
        blockedReason: { code: 'awaiting-input', message: 'Waiting for user input' },
      },
    ])

    // A replaced reason on a still-blocked goal must reach the store: the
    // host republishes the same id/status with the newer explanation.
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 2,
      payload: {
        sessionId: session.id,
        goals: [
          {
            id: 'goal-1',
            title: 'Wait for review',
            status: 'blocked',
            blockedReason: { code: 'round-budget', message: 'Round budget exhausted' },
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.goals).toEqual([
      {
        id: 'goal-1',
        title: 'Wait for review',
        status: 'blocked',
        blockedReason: { code: 'round-budget', message: 'Round budget exhausted' },
      },
    ])

    // A blocked row whose reason lost a half is malformed: the whole snapshot
    // is rejected so the last usable goal state survives.
    client.emit({
      type: 'event',
      name: 'goal.updated',
      sequence: 3,
      payload: {
        sessionId: session.id,
        goals: [
          {
            id: 'goal-1',
            title: 'Wait for review',
            status: 'blocked',
            blockedReason: { code: 'awaiting-input' },
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.goals).toEqual([
      {
        id: 'goal-1',
        title: 'Wait for review',
        status: 'blocked',
        blockedReason: { code: 'round-budget', message: 'Round budget exhausted' },
      },
    ])
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

  it('does not apply partial advisory list snapshots when a row is malformed', async () => {
    const queue = {
      id: 'queue-1',
      sessionId: session.id,
      text: 'queued',
      attachments: [],
      textOnly: true,
      mode: 'queue' as const,
      createdAt: '2026-08-31T00:00:01.000Z',
    }
    const goal = { id: 'goal-1', title: 'Goal', status: 'pending' as const }
    const job = { id: 'job-1', kind: 'worker', label: 'Worker', status: 'running' as const, startedAt: 1 }
    const feedback = { messageId: 'message-1', rating: 'positive' as const, version: '1' }
    const client = new FakeClient((request) => {
      switch (request.type) {
        case 'session.queue.list':
          return [queue, { ...queue, id: 'queue-bad', mode: 'invalid' }]
        case 'goal.list':
          return [goal, { ...goal, id: 'goal-bad', status: 'invalid' }]
        case 'job.list':
          return [job, { ...job, id: 'job-bad', status: 'invalid' }]
        case 'feedback.list':
          return [feedback, { ...feedback, messageId: 'feedback-bad', rating: 'invalid' }]
        default:
          return response(request)
      }
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(store.queue).toEqual([])
    expect(store.goals).toEqual([])
    expect(store.jobs).toEqual([])
    expect(store.feedback).toEqual({})
    store.dispose()
  })

  it('keeps the last complete model catalog when a refresh contains a malformed row', async () => {
    const provider = { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', configurable: false, fields: [] }
    const model = {
      id: 'deepseek-chat',
      providerId: 'deepseek',
      label: 'DeepSeek Chat',
      supportsReasoning: false,
    }
    let malformed = false
    const client = new FakeClient((request) => {
      if (request.type === 'providers.list')
        return malformed ? [provider, { ...provider, id: 3 }] : [provider]
      if (request.type === 'models.list') return malformed ? [model, { ...model, id: 3 }] : [model]
      return response(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.refreshModelCatalog()
    expect(store.providers).toEqual([provider])
    expect(store.models).toEqual([model])

    malformed = true
    await store.refreshModelCatalog()
    expect(store.providers).toEqual([provider])
    expect(store.models).toEqual([model])
    store.dispose()
  })

  it('rejects partial model discovery and preset roster responses', async () => {
    const client = new FakeClient((request) => {
      if (request.type === 'models.discover')
        return {
          models: [
            { id: 'good-model', name: 'Good model' },
            { id: 'bad-model', name: 3 },
          ],
        }
      if (request.type === 'preset.list')
        return {
          presets: [
            { id: 'good', trust: 'user', isDefault: false },
            { id: 'bad', trust: 'future', isDefault: false },
          ],
          authorable: true,
          hasDocument: false,
        }
      return response(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await expect(store.discoverModels({ settingsNamespace: 'models' })).rejects.toThrow()
    await expect(store.loadPresetRoster()).resolves.toBeUndefined()
    expect(store.presets).toEqual([])
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

  it('does not clear an unavailable feedback state after a malformed refresh', async () => {
    let malformed = false
    const client = new FakeClient((request) => {
      if (request.type === 'feedback.list') {
        if (!malformed)
          throw Object.assign(new Error('feedback unavailable'), { code: 'CAPABILITY_UNAVAILABLE' })
        return [{ messageId: 'feedback-1', rating: 'invalid' }]
      }
      return response(request)
    })
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await vi.waitFor(() => expect(store.feedbackUnavailable).toBe(true))

    malformed = true
    await store.loadFeedback(session.id)
    expect(store.feedbackUnavailable).toBe(true)
    expect(store.feedback).toEqual({})
    store.dispose()
  })

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
      textOnly: true,
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

  it('retires a queued row that carries a file when the durable message has no rpcId', async () => {
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
            id: 'queue-file-1',
            sessionId: session.id,
            text: '概括文件内容',
            attachments: [],
            files: ['思路4.md'],
            textOnly: false,
            mode: 'queue' as const,
            createdAt: '2026-09-16T00:00:00.000Z',
          },
        ],
      },
    })
    await Promise.resolve()
    expect(store.queue).toHaveLength(1)

    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 2,
      payload: {
        sessionId: session.id,
        messageId: 'message-1',
        markdown: '概括文件内容',
        source: 'user',
        attachments: [{ name: '思路4.md' }],
      },
    })
    await Promise.resolve()
    expect(store.queue).toEqual([])
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

  it('replaces the steer preview with the durable image message instead of leaving both', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await store.sendPrompt(
      session.id,
      '看这张图',
      [{ uri: 'dsh-attachment:0123456789abcdef', name: 'screen.png', mimeType: 'image/png' }],
      'steer',
    )
    expect(store.timeline.nodes).toHaveLength(1)

    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 1,
      payload: {
        sessionId: session.id,
        messageId: 'message-1',
        markdown: '看这张图',
        source: 'user',
        images: [{ attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }],
      },
    })
    await Promise.resolve()

    expect(store.timeline.nodes).toEqual([
      expect.objectContaining({ kind: 'user-message', id: 'message-1', markdown: '看这张图' }),
    ])
    store.dispose()
  })

  it('routes a slash line to the command surface even when an image is attached', async () => {
    const client = new FakeClient((request) =>
      request.type === 'command.execute' ? { kind: 'success' } : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await store.sendPrompt(session.id, '/compact', [{ uri: 'attachment-1', name: 'shot.png' }], 'queue')

    const executed = client.requests.filter(
      (request): request is Extract<WebviewRequest, { type: 'command.execute' }> =>
        request.type === 'command.execute',
    )
    expect(executed.map((request) => request.payload.command)).toEqual(['/compact'])
    // The composer's own Enter adjudication hands command attachments to
    // `command.execute`; the same keystrokes must not become a model request
    // just because they took the ordinary submit path.
    expect(executed[0]?.payload.attachments).toEqual([{ uri: 'attachment-1', name: 'shot.png' }])
    expect(client.requests.some((request) => request.type === 'session.sendPrompt')).toBe(false)
    store.dispose()
  })
})
