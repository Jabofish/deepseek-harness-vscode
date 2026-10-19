import { describe, expect, it, vi } from 'vitest'
import { AlphaLoopbackApiClient } from '../packages/dsh-adapter/src/versions/alpha/transport.js'
import { alpha212SessionProfile } from '../packages/dsh-adapter/src/versions/alpha212/session-wire.js'
import { createAlpha211SessionNormalizer } from '../packages/dsh-adapter/src/versions/alpha211/tool-preparation.js'
import { DshStreamController } from '../packages/dsh-adapter/src/stream-controller.js'
import { streamingMux } from '../packages/dsh-adapter/test/support/streaming-mux.js'
import { TranscriptWindowService } from '../apps/extension/src/view/transcript-window.js'
import { sanitizePublicValue } from '../apps/extension/src/view/public-value.js'
import {
  transcriptPatchSchema,
  transcriptWindowSchema,
  type TranscriptWindow,
} from '../packages/webview-protocol/src/index.js'
import type { BackendEvent } from '../packages/domain/src/index.js'

// rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317:
// api/session-controller follow + assistant-stream, and client/session's stream fold.
// Network and product Adapter/Host/schema are real; the producer and renderer ACK are fixtures.
//
// The `.stress.spec` suffix keeps this real loopback burst (1,000 frames plus a
// follow repair) out of the default gate, where worker contention used to make
// the drain deadline flaky. Run it with `pnpm test:stress`.
describe('streaming data delivery over loopback WebSocket', { tags: ['stress'] }, () => {
  it('delivers bursts before settlement and retains the prefix through a follow repair', async () => {
    const mux = await streamingMux()
    const sessionId = 'streaming-chain'
    const preview = vi.fn()
    const client = new AlphaLoopbackApiClient({
      endpoint: { host: '127.0.0.1', port: mux.port, baseUrl: `http://127.0.0.1:${mux.port}` },
      requestTimeoutMs: 5_000,
      retryPolicy: { maximumAttempts: 1, baseDelayMs: 1, maximumDelayMs: 1 },
      fetch: globalThis.fetch,
      sessionWireVersion: 'v4',
      sessionWireProfile: alpha212SessionProfile,
      onAssistantPreview: preview,
    })
    let publications = 0
    const host = new TranscriptWindowService({
      read: () => Promise.reject(new Error('Healthy streaming must not read history')),
      publicValue: (value) => sanitizePublicValue(value),
      post: (window) => {
        transcriptWindowSchema.parse(window)
        publications++
        host.acknowledge(window.sessionId, window.revision)
        return Promise.resolve(true)
      },
      postPatch: (patch) => {
        transcriptPatchSchema.parse(patch)
        publications++
        host.acknowledge(patch.sessionId, patch.revision)
        return Promise.resolve(true)
      },
    })
    host.installPage(
      sessionId,
      {
        events: Array.from({ length: 150 }, (_, sequence) => ({
          sequence,
          time: '2026-10-17T00:00:00Z',
          event: {
            type: 'message.completed',
            sessionId,
            messageId: `old-${sequence}`,
            markdown: 'History',
            sequence,
          } as const,
        })),
        hasMore: false,
      },
      host.begin(sessionId),
    )
    const controller = new DshStreamController(client, undefined, undefined, {
      streamSource: (signal) => client.openSessionStream(sessionId, signal),
      normalizeEvent: createAlpha211SessionNormalizer(),
    })
    const received: Extract<BackendEvent, { type: 'message.delta' }>[] = []
    const deliveries = new Map<number, () => void>()
    const waitForDelivery = (count: number): Promise<void> =>
      received.length >= count
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              deliveries.delete(count)
              reject(new Error(`Received ${received.length}/${count} assistant frames`))
            }, 3_000)
            deliveries.set(count, () => {
              clearTimeout(timer)
              resolve()
            })
          })
    controller.subscribe((event) => {
      if (event.type === 'message.delta') received.push(event)
      host.accept(event)
      deliveries.get(received.length)?.()
      deliveries.delete(received.length)
    })
    const snapshot = (assistantStream: unknown): unknown => ({
      type: 'snapshot',
      header: { version: 4, id: sessionId, createdAt: 1, isSeeded: false },
      cursor: 149,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 149, values: {} },
      assistantStream,
    })
    const chunk = (index: number, text: string): unknown => ({
      type: 'assistant-stream',
      frame: {
        type: 'chunk',
        attemptId: 'attempt',
        revision: index + 2,
        index,
        time: Date.now(),
        chunk: { type: 'text-delta', index: 0, text },
      },
    })
    const latest = (): Promise<TranscriptWindow> =>
      host.navigate(sessionId, 'latest', 0, new AbortController().signal)
    try {
      await vi.waitFor(() => expect(mux.opens()).toBe(1))
      mux.item(0, snapshot({ revision: 0 }))
      mux.item(0, {
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 149, turn: 1, step: 1 },
      })
      mux.item(0, chunk(0, 'First '))
      await vi.waitFor(() => expect(received).toHaveLength(1))
      expect((await latest()).nodes.at(-1)).toMatchObject({ markdown: 'First ', streaming: true })
      // Distinct one-character deltas expose reordering without growing the message window.
      const texts = [
        'First ',
        ...Array.from({ length: 1_000 }, (_, index) => String.fromCodePoint(0x4e00 + index)),
      ]
      for (let index = 1; index < texts.length; index++) mux.item(0, chunk(index, texts[index]!))
      // Wait for delivery with an explicit drain deadline; reject inside the
      // test so its finally block releases the socket even if a frame is lost.
      // First-token/recovery limits and the overall test timeout stay unchanged.
      await waitForDelivery(texts.length)
      expect(received.map((event) => event.delta)).toEqual(texts)
      expect(preview).not.toHaveBeenCalled()
      expect(mux.opens()).toBe(1)
      expect((await latest()).nodes.at(-1)).toMatchObject({ markdown: texts.join(''), streaming: true })
      expect(publications).toBeGreaterThan(64)

      // Simulate one genuine discontinuity. The authoritative reconnect baseline
      // contains the missing suffix; it must never replace the on-screen prefix.
      texts.push(' recovered', ' suffix')
      mux.item(0, chunk(texts.length - 1, texts.at(-1)!))
      await vi.waitFor(() => expect(mux.opens()).toBe(2))
      mux.item(
        1,
        snapshot({
          revision: texts.length + 1,
          activeAttempt: {
            attemptId: 'attempt',
            startedAfterSeq: 149,
            turn: 1,
            step: 1,
            nextIndex: texts.length,
            stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: texts.slice(1).map(() => 0), texts }],
          },
        }),
      )
      await vi.waitFor(() => expect(received).toHaveLength(texts.length))
      expect(received.map((event) => event.delta)).toEqual(texts)
      expect((await latest()).nodes.at(-1)).toMatchObject({ markdown: texts.join(''), streaming: true })
      const lastIndex = texts.length
      texts.push(' last')
      mux.item(1, chunk(lastIndex, ' last'))
      await vi.waitFor(() => expect(received).toHaveLength(texts.length))
      const body = texts.join('')
      expect((await latest()).nodes.at(-1)).toMatchObject({ markdown: body, streaming: true })
      mux.item(1, {
        type: 'event',
        event: {
          type: 'assistant/message',
          seq: 150,
          time: Date.now(),
          surfaceOp: 'append',
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'final',
              role: 'assistant',
              source: { kind: 'model', provider: 'fixture', model: 'fixture' },
              content: [{ type: 'text', text: body }],
            },
          },
        },
      })
      mux.item(1, {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'attempt',
          revision: texts.length + 2,
          index: texts.length,
          outcome: { kind: 'committed', eventType: 'assistant/message', seq: 150 },
        },
      })
      await vi.waitFor(async () =>
        expect((await latest()).nodes.at(-1)).toMatchObject({
          id: 'final',
          markdown: body,
          streaming: false,
        }),
      )
      expect(preview).toHaveBeenCalledExactlyOnceWith({ status: 'rebased', phase: 'frame' })
    } finally {
      await controller.close()
      host.dispose()
      await mux.close()
    }
  })
})
