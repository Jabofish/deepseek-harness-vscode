// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type {
  FeatureHostEvent,
  FeatureRequest,
  HostMessage,
  WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'session-change-open'
const WORKSPACE_ID = 'workspace-change-open'
/** The VS Code folder the Host resolved for the session; not the DSH workspace id. */
const WORKSPACE_FOLDER_ID = 'folder-change-open'

interface RecordedFeatureRequest {
  readonly type: string
  readonly payload: unknown
}

class RecordingClient {
  public emptyChanges = false
  public refreshFailed = false
  public requestFails = false
  public firstChangeLocations:
    readonly { readonly relativePath: string; readonly line?: number }[] | undefined
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()
  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }
  public emitFeature(message: FeatureHostEvent): void {
    for (const listener of this.featureListeners) listener(message)
  }
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
    if (request.type === 'changes.list' && this.requestFails) return Promise.reject(new Error('Offline'))
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
          workspaceFolderId: WORKSPACE_FOLDER_ID,
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
        return {
          models: [],
          failures: [],
          current: { providerId: 'deepseek', modelId: 'deepseek-chat' },
          routable: true,
        }
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
      refreshFailed: this.refreshFailed,
      items: this.emptyChanges
        ? []
        : [
            changeSummary('change-first-line', 'src/first.ts', 0, this.firstChangeLocations),
            changeSummary('change-no-line', 'src/whole-file.ts'),
          ],
    }
  }
}

function changeSummary(
  changeId: string,
  relativePath: string,
  line?: number,
  locations?: readonly { readonly relativePath: string; readonly line?: number }[],
): unknown {
  return {
    changeId,
    sessionId: SESSION_ID,
    workspaceFolderId: WORKSPACE_FOLDER_ID,
    relativePath,
    status: 'modified',
    additions: 1,
    deletions: 0,
    evidence: 'structured-proposal',
    applicationState: 'proposed',
    reviewState: 'unreviewed',
    sourceIds: ['tool-1'],
    locations: locations ?? [{ relativePath, ...(line === undefined ? {} : { line }) }],
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

async function openFixture(
  firstChangeLocations?: readonly { readonly relativePath: string; readonly line?: number }[],
): Promise<{
  readonly client: RecordingClient
  readonly store: ReturnType<typeof createAppStore>
}> {
  const client = new RecordingClient()
  client.firstChangeLocations = firstChangeLocations
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
      workspaceFolderId: WORKSPACE_FOLDER_ID,
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
      workspaceFolderId: WORKSPACE_FOLDER_ID,
      relativePath: 'src/whole-file.ts',
      reveal: 'focus',
    })
    store.dispose()
  })

  it('uses a later valid line hint when the first location only identifies the file', async () => {
    const { client, store } = await openFixture([
      { relativePath: 'src/first.ts' },
      { relativePath: 'src/first.ts', line: 7 },
    ])

    await store.openChange('change-first-line')

    expect(openedPayload(client)).toMatchObject({
      relativePath: 'src/first.ts',
      range: { start: { line: 7, column: 0 }, end: { line: 7, column: 0 } },
    })
    store.dispose()
  })
})

it('refreshes a cleared Changes list on session invalidation without manual refresh', async () => {
  const { client, store } = await openFixture()
  try {
    expect(store.changes).toHaveLength(2)
    client.emptyChanges = true
    const message = {
      type: 'feature.event' as const,
      name: 'changes.invalidated' as const,
      sessionId: SESSION_ID,
      identity: {
        stream: 'local' as const,
        backendInstanceId: 'backend-1',
        connectionGeneration: 1,
        localSeq: 2,
        sessionId: SESSION_ID,
      },
    }
    const before = client.featureRequests.length
    client.emitFeature({ ...message, sessionId: 'another-session' })
    expect(client.featureRequests).toHaveLength(before)
    client.emitFeature(message)
    await vi.waitFor(() => expect(store.changes).toEqual([]))
  } finally {
    store.dispose()
  }
})

it.each(['fallback', 'request'] as const)(
  'shows a %s failure without dropping local rows, then clears it on recovery',
  async (mode) => {
    const { client, store } = await openFixture()
    try {
      client.refreshFailed = mode === 'fallback'
      client.requestFails = mode === 'request'
      await store.refreshChanges(SESSION_ID)
      expect(store.changes).toHaveLength(2)
      expect(store.changesRefreshFailed).toBe(true)
      client.refreshFailed = false
      client.requestFails = false
      await store.refreshChanges(SESSION_ID)
      expect(store.changesRefreshFailed).toBe(false)
    } finally {
      store.dispose()
    }
  },
)
