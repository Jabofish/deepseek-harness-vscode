import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { TranscriptWindowService } from '../../../extension/src/view/transcript-window.js'
import { sanitizePublicValue } from '../../../extension/src/view/public-value.js'
import {
  transcriptPatchSchema,
  transcriptWindowSchema,
  type TranscriptWindow,
  type TranscriptPatch,
} from '@dsh-vscode/webview-protocol'
import { createInitialState } from '../app/store/initial-state.js'
import { installTranscript, installTranscriptPatch } from '../app/store/transcript-state.js'
import type { AppState } from '../app/store/types.js'

const prefix = 'report\n'.repeat(37_450)
const chunk = ' streamed content " \\ 中文 😀\n'
const samples = 1024

function report(label: string, durations: number[]): void {
  const sorted = [...durations].sort((a, b) => a - b)
  process.stdout.write(
    `${JSON.stringify({ scenario: label, samples: durations.length, totalMs: durations.reduce((a, b) => a + b, 0), p50Ms: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)] })}\n`,
  )
}

describe('long transcript streaming measurements', { tags: ['stress'] }, () => {
  it.each([
    { mode: 'durable', initial: prefix, count: samples },
    { mode: 'transient', initial: prefix, count: samples },
    { mode: 'transient', initial: 'Short reply', count: 128 },
  ] as const)(
    'preserves host-to-renderer content and metadata ($mode, $count appends)',
    { timeout: 60_000 },
    async ({ mode, initial, count }) => {
      let state: AppState = { ...createInitialState({}), activeSessionId: 's' }
      let deliveries = 0
      let transmittedChars = 0
      const service = new TranscriptWindowService({
        read: () => Promise.resolve({ events: [], hasMore: false }),
        publicValue: (value, cwd) => sanitizePublicValue(value, undefined, [], cwd),
        post: (window) => {
          state = installTranscript(state, transcriptWindowSchema.parse(window) as TranscriptWindow)
          return Promise.resolve(true)
        },
        postPatch: (patch) => {
          deliveries++
          transmittedChars += JSON.stringify(patch).length
          state = installTranscriptPatch(state, transcriptPatchSchema.parse(patch) as TranscriptPatch)
          service.acknowledge('s', patch.revision)
          return Promise.resolve(true)
        },
      })
      try {
        service.installPage(
          's',
          {
            events: [
              {
                sequence: 0,
                time: '2026-10-24T00:00:00Z',
                event: { type: 'message.user', sessionId: 's', messageId: 'u', markdown: 'Report' },
              },
            ],
            hasMore: false,
          },
          service.begin('s'),
        )
        service.accept({
          type: 'message.delta',
          sessionId: 's',
          messageId: 'm',
          delta: initial,
          ...(mode === 'transient'
            ? { transientAttemptId: 'a', transientIndex: 1, transientSequence: 1 }
            : { sequence: 1 }),
        })
        await Promise.resolve()
        const durations: number[] = []
        for (let index = 0; index < count; index++) {
          const start = performance.now()
          service.accept({
            type: 'message.delta',
            sessionId: 's',
            messageId: 'm',
            delta: chunk,
            ...(mode === 'transient'
              ? { transientAttemptId: 'a', transientIndex: index + 2, transientSequence: index + 2 }
              : { sequence: index + 2 }),
          })
          await Promise.resolve()
          durations.push(performance.now() - start)
        }
        report(`host-and-renderer-${mode}-${count}`, durations)
        process.stdout.write(`delivery: ${deliveries} patches, ${transmittedChars} JSON chars\n`)
        expect(deliveries).toBe(count)
        const node = state.transcript?.nodes.find((entry) => entry.id === 'm')
        expect(node?.kind === 'assistant-message' && node.markdown).toBe(initial + chunk.repeat(count))
        expect(state.transcript?.lastSequence).toBe(mode === 'durable' ? count + 1 : 0)
        expect(() => transcriptWindowSchema.parse(state.transcript)).not.toThrow()
      } finally {
        service.dispose()
      }
    },
  )

  it('opens a large directory of transcript rows without changing the bounded resident window', () => {
    const events = Array.from({ length: 1200 }, (_, sequence) => ({
      sequence,
      time: '2026-10-24T00:00:00Z',
      event: {
        type: 'message.completed' as const,
        sessionId: 's',
        messageId: `m-${sequence}`,
        markdown: `Row ${sequence} ` + 'text '.repeat(16),
      },
    }))
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value) => value,
      post: () => Promise.resolve(true),
    })
    const durations: number[] = []
    try {
      for (let index = 0; index < 5; index++) {
        const start = performance.now()
        const window = service.installPage('s', { events, hasMore: false }, service.begin('s'))
        durations.push(performance.now() - start)
        expect(window.nodes.at(-1)?.id).toBe('m-1199')
        expect(window.nodes.length).toBeLessThanOrEqual(256)
        expect(() => transcriptWindowSchema.parse(window)).not.toThrow()
      }
      report('open-1200-rows', durations)
    } finally {
      service.dispose()
    }
  })

  it('preserves renderer budgets while changing metadata on a long message', () => {
    let state = installTranscript(
      { ...createInitialState({}), activeSessionId: 's' },
      {
        sessionId: 's',
        revision: 0,
        lastSequence: 0,
        hasMore: false,
        historical: false,
        eventFacts: [],
        omittedNodeIds: [],
        nodes: [{ kind: 'assistant-message', id: 'm', markdown: prefix, streaming: true }],
      },
    )
    const durations: number[] = []
    let length = prefix.length
    for (let index = 0; index < samples; index++) {
      const patch: TranscriptPatch = {
        sessionId: 's',
        revision: index + 1,
        baseRevision: index,
        changedNodes: [],
        lastSequence: index + 1,
        textUpdates: [
          {
            node: {
              kind: 'assistant-message',
              id: 'm',
              markdown: chunk,
              streaming: true,
              modelLabel: `model-${index}`,
            },
            markdownLength: length,
          },
        ],
      }
      const start = performance.now()
      state = installTranscriptPatch(state, transcriptPatchSchema.parse(patch) as TranscriptPatch)
      durations.push(performance.now() - start)
      length += chunk.length
    }
    report('renderer-only', durations)
    expect(() => transcriptWindowSchema.parse(state.transcript)).not.toThrow()
    const node = state.transcript?.nodes[0]
    expect(node?.kind === 'assistant-message' && node.markdown).toBe(prefix + chunk.repeat(samples))
  })
})
