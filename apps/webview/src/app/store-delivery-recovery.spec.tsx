// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore, type ReactElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, webviewRequestSchema, type WebviewRequest } from '@dsh-vscode/webview-protocol'
import type { BackendEvent } from '@dsh-vscode/domain'
import { TranscriptWindowService } from '../../../extension/src/view/transcript-window.js'
import { ProtocolClient } from './protocol-client.js'
import { createAppStore } from './store.js'
import { Timeline } from '../features/chat/Timeline.js'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it.each([
  { reject: false, outage: 0, rebase: false },
  { reject: true, outage: 700, rebase: false },
  { reject: false, outage: 6_000, rebase: false },
  { reject: true, outage: 6_000, rebase: false },
  { reject: false, outage: 120_000, rebase: false },
  { reject: false, outage: 6_000, rebase: true },
])(
  'recovers a completed answer after refused delivery ($reject, $outage ms, rebase $rebase) without reloading',
  async ({ reject, outage, rebase }) => {
    vi.useFakeTimers()
    const sessionId = 'delivery-session'
    const history: { sequence: number; time: string; event: BackendEvent }[] = []
    const summary = {
      id: sessionId,
      workspaceId: 'w',
      title: 'Delivery fixture',
      blank: false,
      status: 'running',
      createdAt: '2026-10-29T00:00:00Z',
      updatedAt: '2026-10-29T00:00:00Z',
    }
    let sequence = 0
    let refusals = 4
    let initialized = false
    let available = false
    const reports: { attempt: number; retrying: boolean }[] = []
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
            ...summary,
            history: [],
            configuration: {
              preset: 'fixture',
              toolMode: 'native',
              permissionPreset: 'read-only',
              planMode: false,
              model: { providerId: 'fixture', modelId: 'fixture' },
            },
            transcript: host.installPage(
              sessionId,
              { events: [...history], hasMore: false },
              host.begin(sessionId),
            ),
          }
        if (request.type === 'subagent.list') payload = { entries: [], parentAvailable: true }
        if (request.type === 'session.transcript.ack') {
          host.acknowledge(sessionId, request.payload.revision)
          payload = {}
        }
        if (request.type === 'session.transcript.resync')
          payload = host
            .resync(sessionId, new AbortController().signal)
            .then((transcript) => ({ transcript }))
        void Promise.resolve(payload).then((payload) =>
          client.handle({
            protocolVersion: PROTOCOL_VERSION,
            message: { type: 'response', requestId: request.requestId, ok: true, payload },
          }),
        )
      },
    })
    const deliver = (name: string, payload: unknown): Promise<boolean> => {
      if (initialized && name === 'session.transcript.invalidated' && !available)
        return Promise.resolve(false)
      if (
        initialized &&
        (name === 'session.transcript' || name === 'session.transcript.patch') &&
        !available
      ) {
        refusals--
        if (reject) return Promise.reject(new Error('Fixture renderer unavailable'))
        return Promise.resolve(false)
      }
      client.handle({
        protocolVersion: PROTOCOL_VERSION,
        message: { type: 'event', name, sequence: ++sequence, payload },
      })
      return Promise.resolve(true)
    }
    const host = new TranscriptWindowService({
      consumerDriven: true,
      read: () => Promise.resolve({ events: [...history], hasMore: false }),
      publicValue: (value) => value,
      post: (value) => deliver('session.transcript', value),
      postPatch: (value) => deliver('session.transcript.patch', value),
      invalidate: () => {
        void deliver('session.transcript.invalidated', { sessionId })
      },
      report: (report) => reports.push(report),
    })
    const store = createAppStore(client)
    const subscribe = (listener: () => void): (() => void) => store.subscribe(listener)
    const snapshot = (): ReturnType<typeof store.getState> => store.getState()
    function View(): ReactElement {
      const state = useSyncExternalStore(subscribe, snapshot)
      return <Timeline sessionId={sessionId} nodes={state.timeline.nodes} streaming={false} />
    }
    try {
      await store.openSession(sessionId)
      render(<View />)
      initialized = true
      for (const event of [
        {
          type: 'message.completed',
          sessionId,
          messageId: 'answer',
          markdown: 'Recovered final answer',
          turn: 1,
          step: 1,
        },
        { type: 'turn.ended', sessionId, turn: 1, reason: 'completed' },
      ] satisfies BackendEvent[]) {
        history.push({ sequence: history.length, time: '2026-10-29T00:00:00Z', event })
        host.accept({ ...event, sequence: history.length - 1 })
        for (let index = 0; index < 20; index++) await Promise.resolve()
        if (event.type === 'turn.ended') await deliver(event.type, event)
      }
      if (rebase) {
        const missed: BackendEvent = {
          type: 'message.completed',
          sessionId,
          messageId: 'delayed-answer',
          markdown: 'Recovered delayed answer',
          sequence: 2,
        }
        const next: BackendEvent = {
          type: 'turn.ended',
          sessionId,
          turn: 2,
          reason: 'completed',
          sequence: 3,
        }
        history.push(
          { sequence: 2, time: '2026-10-29T00:00:00Z', event: missed },
          { sequence: 3, time: '2026-10-29T00:00:00Z', event: next },
        )
        host.accept(next)
        host.accept(missed)
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(outage)
        available = true
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(reports.some((report) => !report.retrying)).toBe(true)
      expect(refusals).toBeLessThanOrEqual(0)
      expect(screen.getByText('Recovered final answer')).toBeDefined()
      if (rebase) {
        expect(screen.getByText('Recovered delayed answer')).toBeDefined()
        await act(async () => {
          host.accept({
            type: 'message.completed',
            sessionId,
            messageId: 'following-answer',
            markdown: 'Following answer still streams',
            sequence: 4,
          })
          await vi.advanceTimersByTimeAsync(100)
        })
        expect(screen.getByText('Following answer still streams')).toBeDefined()
      }
    } finally {
      host.dispose()
      store.dispose()
    }
  },
)
