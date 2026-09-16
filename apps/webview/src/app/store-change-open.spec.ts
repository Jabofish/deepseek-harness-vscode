// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { FeatureRequest, HostMessage, WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-change-open'
const WORKSPACE_ID = 'workspace-change-open'

interface RecordedFeatureRequest {
  readonly type: string
  readonly payload: unknown
}

class RecordingClient {
  public readonly featureRequests: RecordedFeatureRequest[] = []
  private readonly listeners = new Set<(message: HostMessage) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    return Promise.resolve(this.response(request) as T)
  }

  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    this.featureRequests.push({
      type: request.type,
      payload: 'payload' in request ? request.payload : undefined,
    })
    return Promise.resolve(this.featureResponse(request) as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
  }

  private response(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'session.open':
        return {
          id: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          title: 'Change fixture',
          blank: false,
          status: 'running',
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
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
      case 'models.session.list':
        return { models: [], failures: [] }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }

  private featureResponse(request: FeatureRequest): unknown {
    if (request.type !== 'changes.list') return []
    return {
      kind: 'changes',
      items: [
        changeSummary('change-first-line', 'src/first.ts', 0),
        changeSummary('change-no-line', 'src/whole-file.ts'),
      ],
    }
  }
}

function changeSummary(changeId: string, relativePath: string, line?: number): unknown {
  return {
    changeId,
    sessionId: SESSION_ID,
    workspaceFolderId: WORKSPACE_ID,
    relativePath,
    status: 'modified',
    additions: 1,
    deletions: 0,
    evidence: 'structured-proposal',
    applicationState: 'proposed',
    reviewState: 'unreviewed',
    sourceIds: ['tool-1'],
    locations: [{ relativePath, ...(line === undefined ? {} : { line }) }],
    firstSeenAt: 1_000,
    lastSeenAt: 1_100,
    identity: {
      backendInstanceId: 'backend-1',
      connectionGeneration: 1,
      stream: 'mux',
      sessionId: SESSION_ID,
      serverSeq: 1,
    },
    diffAvailable: true,
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

async function openFixture(): Promise<{
  readonly client: RecordingClient
  readonly store: ReturnType<typeof createAppStore>
}> {
  const client = new RecordingClient()
  const store = createAppStore(client as unknown as ProtocolClient)
  await store.openSession(SESSION_ID)
  await store.refreshChanges(SESSION_ID)
  await settle()
  return { client, store }
}

function openedPayload(client: RecordingClient): unknown {
  return client.featureRequests.filter((entry) => entry.type === 'navigation.open').at(-1)?.payload
}

describe('store change opening', () => {
  it('sends the 0-based first-line hint as the range start instead of dropping it', async () => {
    const { client, store } = await openFixture()

    await store.openChange('change-first-line')

    expect(openedPayload(client)).toEqual({
      workspaceFolderId: WORKSPACE_ID,
      relativePath: 'src/first.ts',
      reveal: 'focus',
      range: { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } },
    })
    store.dispose()
  })

  it('asks for no range when the change carries no usable line', async () => {
    const { client, store } = await openFixture()

    await store.openChange('change-no-line')

    expect(openedPayload(client)).toEqual({
      workspaceFolderId: WORKSPACE_ID,
      relativePath: 'src/whole-file.ts',
      reveal: 'focus',
    })
    store.dispose()
  })
})
