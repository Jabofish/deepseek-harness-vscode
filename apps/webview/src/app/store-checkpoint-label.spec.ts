// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { featureResponseSchema } from '@dsh-vscode/webview-protocol'
import type { FeatureRequest, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

class FakeClient {
  public readonly featureRequests: FeatureRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public constructor(private readonly answer: (request: WebviewRequest | FeatureRequest) => unknown) {}

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.answer(request) as T)
  }

  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    this.featureRequests.push(request)
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
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
} as const

const checkpoint = {
  checkpointId: 'checkpoint-1',
  sessionId: 'session-1',
  workspaceFolderId: 'workspace-1',
  createdAt: 10,
  label: 'Before refactor',
  fileCount: 2,
  totalBytes: 4096,
  state: 'content-ready',
  restoreAllowed: true,
  contentEnabled: true,
  expectedRevision: 4,
} as const

// Every probe fixture is checked against the published protocol schema first:
// if this throws, the fixture drifted from the host contract and the probe
// below would be testing the wrong thing.
function contractPayload(payload: unknown): unknown {
  expect(
    featureResponseSchema.safeParse({
      type: 'feature.response',
      requestId: 'store-parse',
      ok: true,
      payload,
    }).success,
  ).toBe(true)
  return payload
}

function response(request: WebviewRequest | FeatureRequest): unknown {
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
      return []
    case 'subagent.list':
      return { entries: [], parentAvailable: true }
    case 'models.session.list':
      return { models: [], failures: [], routable: true }
    case 'checkpoint.list':
    case 'checkpoint.create':
      return contractPayload({ kind: 'checkpoints', items: [checkpoint] })
    case 'checkpoint.preview':
      return contractPayload({
        kind: 'checkpoint.preview',
        preview: { summary: checkpoint, files: [], conflictCount: 0 },
      })
    default:
      return undefined
  }
}

describe('AppStore checkpoint labels', () => {
  it('keeps the label the host returns for a listed checkpoint', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await store.refreshCheckpoints()

    expect(store.checkpoints.map((entry) => entry.label)).toEqual(['Before refactor'])
    store.dispose()
  })

  it('keeps the label of a checkpoint it just created', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    const created = await store.createCheckpoint('Before refactor')

    const request = client.featureRequests.find((entry) => entry.type === 'checkpoint.create')
    expect(request?.type === 'checkpoint.create' ? request.payload : undefined).toEqual({
      sessionId: 'session-1',
      workspaceFolderId: 'workspace-1',
      label: 'Before refactor',
    })
    expect(created?.label).toBe('Before refactor')
    expect(store.checkpoints.map((entry) => entry.label)).toEqual(['Before refactor'])
    store.dispose()
  })

  it('keeps the label in a checkpoint preview', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    const preview = await store.previewCheckpoint(checkpoint.checkpointId)

    expect(preview?.summary.label).toBe('Before refactor')
    store.dispose()
  })

  it('hands the drawer a translated failure instead of the raw key', async () => {
    // A checkpoint reply without a summary is a host contract violation. The
    // drawer renders `error.message` verbatim in a `role="alert"` node, so the
    // store's own failure text is what the user reads.
    const client = new FakeClient((request) =>
      request.type === 'checkpoint.create'
        ? contractPayload({ kind: 'checkpoints', items: [] })
        : response(request),
    )
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)

    await expect(store.createCheckpoint('Before refactor')).rejects.toThrow(
      'Unable to complete the checkpoint operation.',
    )
    store.dispose()
  })
})
