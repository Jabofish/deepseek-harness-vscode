// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type {
  FeatureHostEvent,
  FeatureRequest,
  HostMessage,
  WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

const SESSION_ID = 'editor-context-send'
const WORKSPACE_FOLDER_ID = 'workspace-editor-context'

function sessionView(id: string): Record<string, unknown> {
  return {
    id,
    workspaceId: WORKSPACE_FOLDER_ID,
    title: `Session ${id}`,
    blank: false,
    status: 'running',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  }
}

/**
 * `parseEditorContextItem` derives `capturedAt` from `expiresAt`, so the
 * counter doubles as the capture order used to sort the rail.
 */
function contextItem(contextRef: string, capturedAt: number): Record<string, unknown> {
  return {
    contextRef,
    kind: 'open-document',
    label: contextRef,
    workspaceFolderId: WORKSPACE_FOLDER_ID,
    relativePath: 'src/app.ts',
    sizeBytes: 12,
    stale: false,
    previewAvailable: false,
    expiresAt: capturedAt,
    scope: {
      ownerId: 'owner-1',
      ownerViewId: 'view-1',
      workspaceFolderId: WORKSPACE_FOLDER_ID,
      expiresAt: capturedAt,
    },
  }
}

/**
 * Stands in for the Extension Host: the opaque handles live in a host-side
 * store that a capture appends to, and `editor.context.list` reports that
 * store verbatim.
 */
class HostClient {
  public holdSend = false
  public failSend = false
  public readonly sentContextRefs: (readonly string[])[] = []
  public readonly executedCommands: string[] = []
  private captured = 1
  private readonly items: Record<string, unknown>[] = []
  private releaseSend: (() => void) | undefined
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    if (request.type === 'session.sendPrompt') {
      this.sentContextRefs.push(request.payload.contextRefs ?? [])
      if (this.failSend) return Promise.reject(new Error('admission rejected'))
      if (this.holdSend)
        return new Promise<T>((resolve) => {
          this.releaseSend = () => resolve(undefined as T)
        })
    }
    return Promise.resolve(this.answer(request) as T)
  }

  public admitSend(): void {
    const release = this.releaseSend
    this.releaseSend = undefined
    release?.()
  }

  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    if (request.type === 'editor.context.list')
      return Promise.resolve({
        kind: 'editor.context',
        items: [...this.items],
        availableKinds: [],
      } as T)
    if (request.type === 'editor.context.capture') {
      const item = contextItem(`context-${this.captured}`, this.captured)
      this.captured += 1
      this.items.push(item)
      return Promise.resolve({ kind: 'editor.context', items: [item], availableKinds: [] } as T)
    }
    return Promise.resolve({ kind: 'ok' } as T)
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public emit(message: HostMessage): void {
    for (const listener of this.listeners) listener(message)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  public dispose(): void {
    this.listeners.clear()
    this.featureListeners.clear()
  }

  private answer(request: WebviewRequest): unknown {
    switch (request.type) {
      case 'command.execute': {
        this.executedCommands.push(request.payload.command)
        return { kind: 'success' }
      }
      case 'session.open': {
        const payload = request.payload as { readonly sessionId?: string } | undefined
        return {
          ...sessionView(payload?.sessionId ?? ''),
          history: [],
          historyHasMore: false,
          permissionPresets: [],
        }
      }
      case 'session.list':
        return { items: [sessionView(SESSION_ID)] }
      case 'session.history':
      case 'subagent.history':
        return { events: [], hasMore: false }
      case 'subagent.list':
        return { entries: [], parentAvailable: true }
      default:
        return []
    }
  }
}

function settle(milliseconds = 24): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function open(): { readonly client: HostClient; readonly store: ReturnType<typeof createAppStore> } {
  const client = new HostClient()
  return { client, store: createAppStore(client as unknown as ProtocolClient) }
}

function refs(store: ReturnType<typeof createAppStore>): readonly string[] {
  return store.editorContext.map((item) => item.ref.contextRef)
}

describe('AppStore editor-context admission', () => {
  it('keeps a chip captured while the send is still in flight', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')
    expect(refs(store)).toEqual(['context-1'])

    client.holdSend = true
    const sending = store.sendPrompt(SESSION_ID, 'first prompt', [], 'queue')
    await settle()
    // The session status only turns `running` once DSH reports it, so the rail
    // stays interactive for the whole round trip.
    await store.captureEditorContext('file')
    expect(refs(store)).toEqual(['context-2', 'context-1'])

    client.admitSend()
    await sending

    // Admission consumed exactly the handles of that one snapshot; a chip the
    // user captured during the round trip was never part of it.
    expect(client.sentContextRefs).toEqual([['context-1']])
    expect(refs(store)).toEqual(['context-2'])
    store.dispose()
  })

  it('keeps every chip when admission rejects the prompt', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')
    await store.captureEditorContext('file')
    expect(refs(store)).toEqual(['context-2', 'context-1'])

    // The host releases the handles only after DSH admits the prompt, so a
    // rejected send leaves them live for the retry.
    client.failSend = true
    await expect(store.sendPrompt(SESSION_ID, 'rejected prompt', [], 'queue')).rejects.toThrow(
      'admission rejected',
    )
    expect(refs(store)).toEqual(['context-2', 'context-1'])
    store.dispose()
  })

  it('runs a slash line as a command instead of prompting the model beside a chip', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')

    await store.sendPrompt(SESSION_ID, '/compact', [], 'queue')

    expect(client.executedCommands).toEqual(['/compact'])
    // A control-plane line is not a prompt, and `command.execute` cannot carry
    // chips; the composer's own command path leaves them attached for the next
    // real message, so this path must not consume them either.
    expect(client.sentContextRefs).toEqual([])
    expect(refs(store)).toEqual(['context-1'])
    store.dispose()
  })

  it('replaces a steer preview once the durable message carries the resolved chips', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')

    await store.sendPrompt(SESSION_ID, 'look at this', [], 'steer')
    expect(store.timeline.nodes).toHaveLength(1)

    // The Extension Host resolved the chip into a prompt attachment the
    // Webview never listed in its preview, and the durable projection reports
    // it by name.
    client.emit({
      type: 'event',
      name: 'message.user',
      sequence: 1,
      payload: {
        sessionId: SESSION_ID,
        messageId: 'message-context-1',
        markdown: 'look at this',
        source: 'user',
        attachments: [{ name: 'src/app.ts' }],
      },
    })
    await settle()

    expect(store.timeline.nodes).toEqual([
      expect.objectContaining({ kind: 'user-message', id: 'message-context-1' }),
    ])
    store.dispose()
  })
})
