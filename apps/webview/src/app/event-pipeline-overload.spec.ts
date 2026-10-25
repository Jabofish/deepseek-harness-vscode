import { describe, expect, it, vi } from 'vitest'
import type { BackendEvent, SessionHistoryEvent } from '@dsh-vscode/domain'
import type { TimelineNode } from '@dsh-vscode/timeline'
import {
  PROTOCOL_VERSION,
  webviewRequestSchema,
  type HostMessage,
  type TranscriptWindow,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'
import { BoundedEventQueue } from '../../../extension/src/view/bounded-event-queue.js'
import { ControlDelivery } from '../../../extension/src/view/control-delivery.js'
import { TranscriptWindowService } from '../../../extension/src/view/transcript-window.js'
import { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import { installTranscript, parseTranscript } from './store/transcript-state.js'
import { createInitialState } from './store/initial-state.js'

function assistantEntry(sequence: number, id: string, text: string): SessionHistoryEvent {
  return {
    sequence,
    time: '2026-10-14T00:00:00.000Z',
    event: {
      type: 'message.completed',
      sessionId: 'session-active',
      sequence,
      messageId: id,
      markdown: text,
    },
  }
}

function toolEntry(sequence: number, id: string, inputSummary: string): SessionHistoryEvent {
  return {
    sequence,
    time: '2026-10-14T00:00:00.000Z',
    event: {
      type: 'tool.updated',
      sessionId: 'session-active',
      sequence,
      tool: {
        id,
        name: 'bash',
        category: 'shell',
        title: `Run ${id}`,
        status: 'completed',
        inputSummary,
        outputSummary: 'ok',
        metadata: {},
      },
    },
  }
}

describe('event-pipeline overload reproduction and metrics (Issue #20)', () => {
  it('bounds recovery count, directory rereads, hidden-session projection work, and control latency under mixed overload', async () => {
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

    const activeSessionId = 'session-active'
    const hiddenSessionId = 'session-hidden'

    const metrics = {
      sessionOpenReads: 0,
      appReadyCalls: 0,
      directoryListReads: 0,
      transcriptResyncReads: 0,
      fullNodeReads: 0,
      resyncEventsSent: 0,
      maxControlLatencyMs: 0,
    }

    const historyEvents: SessionHistoryEvent[] = [
      assistantEntry(1, 'm-1', 'Stable first answer'),
      assistantEntry(2, 'm-2', 'Stable second answer'),
    ]

    const openReleaseQueue: Array<() => void> = []
    let deferSessionOpen = false

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

        const respond = (payload: unknown): void => {
          client.handle({
            protocolVersion: PROTOCOL_VERSION,
            message: { type: 'response', requestId: request.requestId, ok: true, payload },
          })
        }

        if (request.type === 'app.ready') {
          metrics.appReadyCalls += 1
          client.handle({
            protocolVersion: PROTOCOL_VERSION,
            message: {
              type: 'event',
              name: 'connection.snapshot',
              sequence: ++hostSequence,
              payload: {
                kind: 'connected',
                backendInstanceId: 'backend-1',
                connectionGeneration: 1,
                dshVersion: '0.2.1-alpha.2',
              },
            },
          })
          respond({})
          return
        }
        if (request.type === 'session.list' || request.type === 'workspace.list') {
          metrics.directoryListReads += 1
          respond(
            request.type === 'session.list'
              ? {
                  items: [
                    {
                      id: activeSessionId,
                      workspaceId: 'ws-1',
                      title: 'Active Session',
                      blank: false,
                      status: 'running',
                      createdAt: '2026-10-20T00:00:00Z',
                      updatedAt: '2026-10-20T00:00:00Z',
                    },
                  ],
                }
              : [],
          )
          return
        }
        if (request.type === 'session.transcript.resync') {
          metrics.transcriptResyncReads += 1
          const finish = (): void => {
            void activeWindow
              .resync(activeSessionId, new AbortController().signal)
              .then((transcript) => respond({ transcript }))
          }
          if (deferSessionOpen) openReleaseQueue.push(finish)
          else finish()
          return
        }
        if (request.type === 'ui.events.ack') {
          controls.acknowledge('main', request.payload.sequence)
          respond({})
          return
        }
        if (request.type === 'session.transcript.node') {
          metrics.fullNodeReads += 1
          const node = activeWindow.fullNode(
            request.payload.sessionId,
            request.payload.nodeId,
            request.payload.revision,
            new AbortController().signal,
          )
          respond({ node })
          return
        }
        if (request.type === 'session.transcript.ack') {
          activeWindow.acknowledge(request.payload.sessionId, request.payload.revision)
          respond({})
          return
        }
        if (request.type === 'subagent.list') {
          respond({ entries: [], parentAvailable: true })
          return
        }
        if (request.type === 'session.open') {
          metrics.sessionOpenReads += 1
          const finishOpen = (): void => {
            const gen = activeWindow.begin(activeSessionId)
            const transcript = activeWindow.installPage(
              activeSessionId,
              { events: historyEvents, hasMore: false },
              gen,
            )
            respond({
              id: activeSessionId,
              workspaceId: 'ws-1',
              title: 'Active Session',
              blank: false,
              status: 'running',
              createdAt: '2026-10-20T00:00:00Z',
              updatedAt: '2026-10-20T00:00:00Z',
              history: [],
              transcript,
            })
          }
          if (deferSessionOpen) {
            openReleaseQueue.push(finishOpen)
          } else {
            finishOpen()
          }
          return
        }
        respond([])
      },
    })

    const store = createAppStore(client)
    let hostSequence = 0
    let slowPanelReceipts = false
    const pendingReceipts: Array<(delivered: boolean) => void> = []

    const deliver = (message: HostMessage): Promise<boolean> => {
      client.handle({ protocolVersion: PROTOCOL_VERSION, message })
      if (slowPanelReceipts) {
        return new Promise<boolean>((resolve) => {
          pendingReceipts.push(resolve)
        })
      }
      return Promise.resolve(true)
    }

    const queue = new BoundedEventQueue(
      async (info) => {
        if (info?.priority === false) return
        metrics.resyncEventsSent += 1
        await deliver({ type: 'event', name: 'ui.resync', sequence: ++hostSequence, payload: {} })
      },
      8,
      256 * 1024,
    )

    const controls = new ControlDelivery(
      (_, message) => deliver(message),
      () => ++hostSequence,
      () => true,
    )
    const postEvent = (name: string, payload: unknown, priority = false): Promise<boolean> =>
      priority
        ? controls.enqueue('main', { type: 'event', name, sequence: 0, payload })
        : queue.enqueue(
            () => deliver({ type: 'event', name, sequence: ++hostSequence, payload }),
            JSON.stringify(payload).length,
            priority,
          )

    const activeWindow = new TranscriptWindowService({
      consumerDriven: true,
      read: () => Promise.resolve({ events: historyEvents, hasMore: false }),
      publicValue: (value) => value,
      post: (value) => postEvent('session.transcript', value, false),
      postPatch: (value) => postEvent('session.transcript.patch', value, false),
      invalidate: (sessionId) => {
        void postEvent('session.transcript.invalidated', { sessionId }, true)
      },
    })

    const hiddenWindow = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: () => Promise.resolve(true),
      postPatch: () => Promise.resolve(true),
    })
    hiddenWindow.setVisible(false)
    hiddenWindow.installPage(
      hiddenSessionId,
      { events: [], hasMore: false },
      hiddenWindow.begin(hiddenSessionId),
    )

    try {
      await client.request({ type: 'app.ready', requestId: 'initial-ready', payload: { snapshotOnly: true } })
      await store.openSession(activeSessionId)
      const baselineOpens = metrics.sessionOpenReads
      const baselineDirectoryReads = metrics.directoryListReads
      const baselineResyncs = metrics.transcriptResyncReads

      // 1. Slow panel + repeated transcript invalidations while session.open is in flight:
      // Single-flight protection should coalesce concurrent invalidations and avoid
      // triggering unrelated workspace/session directory refreshes.
      deferSessionOpen = true
      for (let i = 0; i < 4; i += 1) {
        await postEvent('session.transcript.invalidated', { sessionId: activeSessionId }, true)
      }
      expect(metrics.sessionOpenReads - baselineOpens).toBe(0)
      expect(metrics.transcriptResyncReads - baselineResyncs).toBe(1)
      expect(metrics.directoryListReads - baselineDirectoryReads).toBe(0)

      while (openReleaseQueue.length > 0) {
        openReleaseQueue.shift()?.()
      }
      deferSessionOpen = false
      for (let i = 0; i < 6; i += 1) await Promise.resolve()

      // Global recovery stays single-flight through installation, rather than
      // releasing its guard as soon as app.ready answers. Repeated invalidations
      // in the trailing pass must wait for a cooldown instead of hot-looping.
      const readyBefore = metrics.appReadyCalls
      const opensBefore = metrics.sessionOpenReads
      const resyncsBefore = metrics.transcriptResyncReads
      deferSessionOpen = true
      await postEvent('ui.resync', {}, true)
      for (let i = 0; i < 20; i++) await Promise.resolve()
      for (let i = 0; i < 4; i++) await postEvent('ui.resync', {}, true)
      expect(metrics.appReadyCalls - readyBefore).toBe(1)
      expect(metrics.sessionOpenReads - opensBefore).toBe(0)
      expect(metrics.transcriptResyncReads - resyncsBefore).toBe(1)
      openReleaseQueue.shift()?.()
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(metrics.appReadyCalls - readyBefore).toBe(2)
      expect(metrics.sessionOpenReads - opensBefore).toBe(0)
      expect(metrics.transcriptResyncReads - resyncsBefore).toBe(2)
      for (let i = 0; i < 4; i++) await postEvent('ui.resync', {}, true)
      openReleaseQueue.shift()?.()
      deferSessionOpen = false
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(metrics.appReadyCalls - readyBefore).toBe(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(metrics.appReadyCalls - readyBefore).toBe(3)
      expect(metrics.sessionOpenReads - opensBefore).toBe(0)
      expect(metrics.transcriptResyncReads - resyncsBefore).toBe(3)

      // 2. Hidden running session receiving 200 streaming deltas should defer
      // expensive display bounding until the window becomes visible.
      const hiddenBoundSpy = vi.spyOn(
        hiddenWindow as unknown as { bound: (resident: unknown) => void },
        'bound',
      )
      for (let i = 1; i <= 200; i += 1) {
        hiddenWindow.accept({
          type: 'message.delta',
          sessionId: hiddenSessionId,
          messageId: 'hidden-msg',
          delta: `chunk-${i} `,
        })
      }
      const hiddenBoundsDuringStream = hiddenBoundSpy.mock.calls.length
      hiddenWindow.setVisible(true)
      expect(hiddenBoundsDuringStream).toBe(0)
      expect(hiddenBoundSpy.mock.calls.length).toBe(2)

      // 3. High-frequency bulk deltas with stalled panel receipts + urgent control event:
      slowPanelReceipts = true
      for (let i = 1; i <= 40; i += 1) {
        activeWindow.accept({
          type: 'message.delta',
          sessionId: activeSessionId,
          messageId: 'live-msg',
          delta: `token-${i} `,
        })
      }
      const controlStart = performance.now()
      const permissionEvent: BackendEvent = {
        type: 'permission.requested',
        request: {
          id: 'perm-urgent',
          sessionId: activeSessionId,
          title: 'Run command',
          description: 'Allow test command',
          risk: 'low',
          options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }],
        },
      }
      void postEvent(permissionEvent.type, permissionEvent, true)
      await Promise.resolve()
      if (store.getState().permissions.some((item) => item.id === 'perm-urgent')) {
        metrics.maxControlLatencyMs = Math.max(metrics.maxControlLatencyMs, performance.now() - controlStart)
      }
      expect(store.getState().permissions.map((item) => item.id)).toContain('perm-urgent')
      expect(metrics.maxControlLatencyMs).toBeLessThanOrEqual(5)
    } finally {
      while (pendingReceipts.length > 0) pendingReceipts.shift()?.(true)
      activeWindow.dispose()
      hiddenWindow.dispose()
      queue.dispose()
      controls.dispose()
      store.dispose()
      if (previousWindow !== undefined) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      vi.useRealTimers()
    }
  })

  it('preserves unchanged node identities across full reload while refreshing omitted nodes whose full body changed behind an identical preview', () => {
    const sessionId = 'session-active'
    const sharedPrefix = 'A'.repeat(20 * 1024)
    const host = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: () => Promise.resolve(true),
    })

    try {
      const page1: SessionHistoryEvent[] = [
        assistantEntry(1, 'm-unchanged', 'Short stable message'),
        toolEntry(2, 'm-omitted-same', `${sharedPrefix}-tail-stable`),
        toolEntry(3, 'm-omitted-mutated', `${sharedPrefix}-tail-v1`),
      ]
      const window1: TranscriptWindow = host.installPage(
        sessionId,
        { events: page1, hasMore: false },
        host.begin(sessionId),
      )

      const state1 = installTranscript(
        { ...createInitialState({}), activeSessionId: sessionId },
        parseTranscript(window1),
      )

      const page2: SessionHistoryEvent[] = [
        assistantEntry(1, 'm-unchanged', 'Short stable message'),
        toolEntry(2, 'm-omitted-same', `${sharedPrefix}-tail-stable`),
        toolEntry(3, 'm-omitted-mutated', `${sharedPrefix}-tail-v2`),
        assistantEntry(4, 'm-new', 'Added on reload'),
      ]
      const window2: TranscriptWindow = host.installPage(
        sessionId,
        { events: page2, hasMore: false },
        host.begin(sessionId),
      )

      // Both omitted tool nodes exceed the 4096-char inputSummary preview cap with
      // the exact same 20 KiB prefix, so their truncated preview in window1 and window2
      // is byte-for-byte identical.
      const preview1Mutated = window1.nodes.find(
        (node): node is Extract<TimelineNode, { kind: 'tool' }> =>
          node.id === 'm-omitted-mutated' && node.kind === 'tool',
      )
      const preview2Mutated = window2.nodes.find(
        (node): node is Extract<TimelineNode, { kind: 'tool' }> =>
          node.id === 'm-omitted-mutated' && node.kind === 'tool',
      )
      expect(preview1Mutated?.tool.inputSummary).toBe(preview2Mutated?.tool.inputSummary)

      const state2 = installTranscript(state1, parseTranscript(window2))

      expect(state1.transcript?.contentVersions).toEqual(window1.contentVersions)
      expect(state2.transcript?.contentVersions).toEqual(window2.contentVersions)
      expect(window1.omittedNodeIds).toContain('m-omitted-same')
      expect(window1.contentVersions?.['m-omitted-same']).toBeDefined()
      expect(window2.contentVersions?.['m-omitted-same']).toBe(window1.contentVersions?.['m-omitted-same'])
      expect(window2.contentVersions?.['m-omitted-mutated']).not.toBe(
        window1.contentVersions?.['m-omitted-mutated'],
      )

      // 1. Unchanged non-omitted node keeps its exact object identity
      expect(state2.transcript?.nodes[0]).toBe(state1.transcript?.nodes[0])
      // 2. Unchanged omitted node keeps its exact object identity (avoiding redundant fullNode RPC)
      expect(state2.transcript?.nodes[1]).toBe(state1.transcript?.nodes[1])
      // 3. Omitted node whose full body changed behind an identical truncated preview
      // MUST receive a new object reference so useCompleteTranscriptNodes refetches it!
      expect(state2.transcript?.nodes[2]).not.toBe(state1.transcript?.nodes[2])
    } finally {
      host.dispose()
    }
  })
})
