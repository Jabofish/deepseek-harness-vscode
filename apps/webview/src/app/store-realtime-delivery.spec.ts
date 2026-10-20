import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent } from '@dsh-vscode/domain'
import {
  PROTOCOL_VERSION,
  webviewRequestSchema,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import { BoundedEventQueue } from '../../../extension/src/view/bounded-event-queue.js'
import { TranscriptWindowService } from '../../../extension/src/view/transcript-window.js'
import { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'

describe('realtime Host to Webview delivery', () => {
  it('installs subsequent text and tool context before an earlier IPC receipt and the question panel', async () => {
    vi.useFakeTimers()
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const events = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    })
    let release!: (value: boolean) => void
    const receipt = new Promise<boolean>((resolve) => {
      release = resolve
    })
    const sessionId = 'session-live'
    const client = new ProtocolClient({
      getState: () => undefined,
      setState: () => undefined,
      postMessage: (raw) => {
        const request = (raw as { message: WebviewRequest }).message
        if (!webviewRequestSchema.safeParse(request).success) {
          client.handle({
            protocolVersion: PROTOCOL_VERSION,
            message: {
              type: 'feature.response',
              requestId: request.requestId,
              ok: true,
              payload: { kind: 'editor.context', items: [], availableKinds: [] },
            },
          })
          return
        }
        let payload: unknown = []
        if (request.type === 'session.open')
          payload = {
            id: sessionId,
            workspaceId: 'workspace',
            title: 'Live',
            blank: false,
            status: 'running',
            createdAt: '2026-10-20T00:00:00Z',
            updatedAt: '2026-10-20T00:00:00Z',
            history: [],
            transcript,
          }
        if (request.type === 'subagent.list') payload = { entries: [], parentAvailable: true }
        if (request.type === 'session.transcript.ack') {
          host.acknowledge(request.payload.sessionId, request.payload.revision)
          payload = {}
        }
        client.handle({
          protocolVersion: PROTOCOL_VERSION,
          message: { type: 'response', requestId: request.requestId, ok: true, payload },
        })
      },
    })
    const store = createAppStore(client)
    let first = true
    const deliver = (message: HostMessage): Promise<boolean> => {
      client.handle({ protocolVersion: PROTOCOL_VERSION, message })
      if (first) {
        first = false
        return receipt
      }
      return Promise.resolve(true)
    }
    const queue = new BoundedEventQueue(async () => {})
    let sequence = 0
    const post = (name: string, payload: unknown): Promise<boolean> =>
      queue.enqueue(
        () => deliver({ type: 'event', name, sequence: ++sequence, payload }),
        JSON.stringify(payload).length,
      )
    const host = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => post('session.transcript', value),
      postPatch: (value) => post('session.transcript.patch', value),
    })
    const transcript = host.installPage(sessionId, { events: [], hasMore: false }, host.begin(sessionId))
    try {
      await store.openSession(sessionId)
      for (const text of ['first', ' second']) {
        host.accept({ type: 'message.delta', sessionId, messageId: 'live', delta: text })
        await Promise.resolve()
      }
      expect(store.getState().timeline.nodes).toContainEqual(
        expect.objectContaining({ markdown: 'first second' }),
      )
      const tool: BackendEvent = {
        type: 'tool.updated',
        sessionId,
        sequence: 0,
        tool: {
          id: 'call',
          name: 'ask_user_question',
          category: 'other',
          title: 'Question',
          status: 'running',
          metadata: {},
        },
      }
      host.accept(tool)
      await Promise.resolve()
      expect(store.getState().timeline.nodes).toContainEqual(
        expect.objectContaining({ kind: 'tool', id: 'call' }),
      )
      const observed = vi.fn()
      const unsubscribe = client.subscribe((message) => {
        if (message.type === 'event' && message.name === 'question.requested') {
          expect(store.getState().timeline.nodes).toContainEqual(
            expect.objectContaining({ kind: 'tool', id: 'call' }),
          )
          observed()
        }
      })
      await post('question.requested', {
        type: 'question.requested',
        question: {
          id: 'question',
          sessionId,
          callId: 'call',
          prompt: 'Continue?',
          allowFreeText: true,
        },
      })
      expect(observed).toHaveBeenCalledOnce()
      unsubscribe()
      for (let index = 0; index < 8; index++) await Promise.resolve()
    } finally {
      release(true)
      host.dispose()
      queue.dispose()
      store.dispose()
      if (previousWindow !== undefined) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      vi.useRealTimers()
    }
  })
})
