// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { featureResponseSchema } from '@dsh-vscode/webview-protocol'
import type { FeatureRequest, HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

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
  workspaceFolderId: 'folder-1',
  title: 'Session',
  blank: false,
  status: 'running',
  createdAt: '2026-08-31T00:00:00.000Z',
  updatedAt: '2026-08-31T00:00:00.000Z',
} as const

const checkpoint = {
  checkpointId: 'checkpoint-1',
  sessionId: 'session-1',
  workspaceFolderId: 'folder-1',
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
      return {
        models: [],
        failures: [],
        current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
        routable: true,
      }
    case 'checkpoint.list':
    case 'checkpoint.create':
      return contractPayload({ kind: 'checkpoints', items: [checkpoint] })
    case 'checkpoint.preview':
      return contractPayload({
        kind: 'checkpoint.preview',
        preview: { previewId: 'dsh-preview-test-1', summary: checkpoint, files: [], conflictCount: 0 },
      })
    case 'checkpoint.restore':
      return contractPayload({ kind: 'operation', operationId: request.requestId, state: 'completed' })
    default:
      return undefined
  }
}

describe('AppStore checkpoint labels', () => {
  it('sends the host-issued preview id with a restore confirmation', async () => {
    const client = new FakeClient(response)
    const store = createAppStore(client as unknown as ProtocolClient)

    await store.openSession(session.id)
    await store.refreshCheckpoints()
    const preview = await store.previewCheckpoint(checkpoint.checkpointId)
    expect(preview?.previewId).toBe('dsh-preview-test-1')
    await store.restoreCheckpoint(checkpoint.checkpointId, preview?.previewId ?? '', 'overwrite')

    const request = client.featureRequests.find((entry) => entry.type === 'checkpoint.restore')
    expect(request?.type === 'checkpoint.restore' ? request.payload : undefined).toEqual({
      checkpointId: checkpoint.checkpointId,
      sessionId: session.id,
      workspaceFolderId: 'folder-1',
      expectedCurrentRevision: checkpoint.expectedRevision,
      previewId: 'dsh-preview-test-1',
      conflictPolicy: 'overwrite',
    })
    store.dispose()
  })
})
