// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { FeatureHostEvent, FeatureRequest, HostMessage } from '@dsh-vscode/webview-protocol'
import type { ProtocolClient } from './protocol-client.js'
import {
  createHostBackedAppStore as createAppStore,
  type FixtureRequest as WebviewRequest,
} from '../test/host-window-store.js'

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
  public openFileAsContext = false
  public releaseGate: Promise<void> | undefined
  public contextListGate: Promise<void> | undefined
  public readonly cancelledSessions: string[] = []
  public readonly releasedContextRefs: (readonly string[])[] = []
  public readonly sentContextRefs: (readonly string[])[] = []
  public readonly executedCommands: string[] = []
  private captured = 1
  private readonly items: Record<string, unknown>[] = []
  private releaseSend: (() => void) | undefined
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()

  public request<T>(request: WebviewRequest): Promise<T> {
    if (request.type === 'session.cancel') this.cancelledSessions.push(request.payload.sessionId)
    if (request.type === 'attachment.open.attach' && this.openFileAsContext) {
      const item = {
        ...contextItem(`context-${this.captured}`, this.captured),
        sourceCandidateId: request.payload.candidateId,
      }
      this.captured += 1
      this.items.push(item)
      return Promise.resolve({ kind: 'editor.context', items: [item] } as T)
    }
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
    if (request.type === 'editor.context.release') {
      const refs = request.payload.contextRefs
      this.releasedContextRefs.push(refs)
      return (this.releaseGate ?? Promise.resolve()).then(() => {
        for (let index = this.items.length - 1; index >= 0; index--)
          if (refs.includes(this.items[index]?.contextRef as string)) this.items.splice(index, 1)
        return { kind: 'ok' } as T
      })
    }
    if (request.type === 'editor.context.list') {
      const result = {
        kind: 'editor.context',
        items: [...this.items],
        availableKinds: [],
      } as T
      return (this.contextListGate ?? Promise.resolve()).then(() => result)
    }
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
      case 'workspace.list':
        return {
          items: [
            {
              id: WORKSPACE_FOLDER_ID,
              name: 'Workspace',
              sessionCount: 1,
              sessionIds: [SESSION_ID],
              createdAt: '2026-09-14T00:00:00.000Z',
              updatedAt: '2026-09-14T00:00:00.000Z',
            },
          ],
          archivedSessionIds: [],
        }
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
  it.each(['session', 'subagent', 'draft'] as const)(
    'opens a %s without waiting for old context cleanup or restoring its handles',
    async (target) => {
      const { client, store } = open()
      let release!: () => void
      let navigation: Promise<void> | undefined
      try {
        await store.refreshSessions()
        await store.openSession(SESSION_ID)
        await store.captureEditorContext('file')
        expect(refs(store)).toEqual(['context-1'])
        client.releaseGate = new Promise<void>((resolve) => {
          release = resolve
        })
        let completed = false
        navigation = (
          target === 'session'
            ? store.openSession('other')
            : target === 'draft'
              ? store.stageSession(WORKSPACE_FOLDER_ID)
              : store.openSubagent(
                  {
                    kind: 'child',
                    id: 'child',
                    label: 'Worker',
                    activity: 'running',
                    parentSessionId: SESSION_ID,
                    mode: 'continuable',
                    hasChildren: false,
                  },
                  true,
                )
        ).then(() => {
          completed = true
        })
        await vi.waitFor(() => expect(completed).toBe(true))
        expect(refs(store)).toEqual([])
        expect(client.releasedContextRefs).toEqual([['context-1']])
        if (target === 'session') {
          expect(store.activeSessionId).toBe('other')
          await store.sendPrompt('other', 'Continue', [], 'queue')
          await store.cancelSession('other')
          expect(client.sentContextRefs).toEqual([[]])
          expect(client.cancelledSessions).toEqual(['other'])
        }
        if (target === 'subagent') expect(store.getState().activeSubagent?.entry.id).toBe('child')
        if (target === 'draft') expect(store.getState().pendingSession).toBeDefined()
        release()
        await vi.waitFor(() => expect(store.getState().editorContextLoading).toBe(false))
        expect(refs(store)).toEqual([])
      } finally {
        release?.()
        await navigation
        store.dispose()
      }
    },
  )

  it.each(['subagent', 'draft'] as const)(
    'ignores the old context list after entering a %s',
    async (target) => {
      const { client, store } = open()
      let release!: () => void
      let list: Promise<void> | undefined
      try {
        await store.refreshSessions()
        await store.openSession(SESSION_ID)
        await store.captureEditorContext('file')
        client.contextListGate = new Promise<void>((resolve) => {
          release = resolve
        })
        list = store.refreshEditorContext()
        if (target === 'draft') await store.stageSession(WORKSPACE_FOLDER_ID)
        else
          await store.openSubagent(
            {
              kind: 'child',
              id: 'child',
              label: 'Worker',
              activity: 'running',
              parentSessionId: SESSION_ID,
              mode: 'continuable',
              hasChildren: false,
            },
            true,
          )
        release()
        await list
        expect(refs(store)).toEqual([])
      } finally {
        release?.()
        await list
        store.dispose()
      }
    },
  )

  it('cancels a capture waiting for cleanup if the user moves to another conversation', async () => {
    const { client, store } = open()
    let release!: () => void
    try {
      await store.openSession(SESSION_ID)
      await store.captureEditorContext('file')
      client.releaseGate = new Promise<void>((resolve) => {
        release = resolve
      })
      await store.openSession('other')
      const capture = store.captureEditorContext('file')
      const cancelled = expect(capture).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
      await store.openSession('third')
      release()
      await cancelled
      expect(refs(store)).toEqual([])
    } finally {
      release?.()
      store.dispose()
    }
  })

  it('uses the same file context when an open-file candidate is selected', async () => {
    const { client, store } = open()
    client.openFileAsContext = true
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')

    const selected = await store.attachOpenFile('dsh-open-file-0123456789abcdef0123456789abcdef', () => true)
    expect(selected).toEqual({ kind: 'context', contextRef: 'context-2' })
    expect(refs(store)).toEqual(['context-2'])
    expect(store.editorContext[0]?.ref.sourceCandidateId).toBe(
      'dsh-open-file-0123456789abcdef0123456789abcdef',
    )

    await store.sendPrompt(SESSION_ID, 'inspect file', [], 'queue')
    expect(client.sentContextRefs).toEqual([['context-2']])
    store.dispose()
  })

  it('shows and submits one file when repeated Host captures return distinct refs', async () => {
    const { client, store } = open()
    await store.openSession(SESSION_ID)
    await settle()
    await store.captureEditorContext('file')
    await store.captureEditorContext('file')

    expect(refs(store)).toEqual(['context-2'])
    await store.refreshEditorContext()
    expect(refs(store)).toEqual(['context-2'])
    await store.sendPrompt(SESSION_ID, 'inspect file', [], 'queue')
    expect(client.sentContextRefs).toEqual([['context-2']])
    store.dispose()
  })

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
    expect(refs(store)).toEqual(['context-2'])

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
    expect(refs(store)).toEqual(['context-2'])

    // The host releases the handles only after DSH admits the prompt, so a
    // rejected send leaves them live for the retry.
    client.failSend = true
    await expect(store.sendPrompt(SESSION_ID, 'rejected prompt', [], 'queue')).rejects.toThrow(
      'admission rejected',
    )
    expect(refs(store)).toEqual(['context-2'])
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
