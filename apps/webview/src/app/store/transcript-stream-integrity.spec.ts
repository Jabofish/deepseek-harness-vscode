/**
 * Round-trip integrity for the streaming transcript pipeline: the real Host
 * TranscriptWindowService streams a conversation, the patches it publishes are
 * installed through the real Webview store path, and the reconstructed
 * conversation must match the streamed content byte for byte.
 *
 * This pins the behavior-preservation contract of the streaming fast paths
 * (incremental size tracking and suffix patches): corruption, duplication,
 * reordering and budget drift fail here.
 */
import { describe, expect, it } from 'vitest'

import { sanitizePublicValue } from '../../../../extension/src/view/public-value.js'
import { TranscriptWindowService } from '../../../../extension/src/view/transcript-window.js'
import { transcriptPatchSchema, transcriptWindowSchema } from '@dsh-vscode/webview-protocol'
import type { TranscriptPatch, TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { installTranscript, installTranscriptPatch } from './transcript-state.js'
import type { AppState } from './types.js'
import { createInitialState } from './initial-state.js'
import type { BackendEvent } from '@dsh-vscode/domain'

const SESSION = 'integrity-session'
const WORKSPACE_ROOT = 'D:\\workspaces\\demo'

function prose(targetChars: number, seed: number): string {
  let state = seed
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
  const words = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'.split(' ')
  const lines: string[] = []
  let line: string[] = []
  let produced = 0
  while (produced < targetChars) {
    line.push(words[Math.floor(next() * words.length)] ?? 'lorem')
    produced += 6
    if (line.length >= 10) {
      lines.push(line.join(' '))
      line = []
      if (lines.length % 5 === 0) {
        lines.push('')
        produced += 1
      }
    }
  }
  if (line.length > 0) lines.push(line.join(' '))
  return lines.join('\n').slice(0, targetChars)
}

async function accept(service: TranscriptWindowService, event: BackendEvent): Promise<void> {
  await Promise.resolve().then(() => service.accept(event))
}

describe('transcript stream integrity (direct service handle)', () => {
  it('reconstructs streamed text and current facts exactly through coalesced patches', async () => {
    const state: { current: AppState } = {
      current: { ...createInitialState({}), activeSessionId: SESSION },
    }
    const patches: TranscriptPatch[] = []
    const pendingAcks: { sessionId: string; revision: number }[] = []
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value, cwd) => sanitizePublicValue(value, undefined, [WORKSPACE_ROOT], cwd),
      post: (window) => {
        state.current = installTranscript(
          state.current,
          transcriptWindowSchema.parse(window) as TranscriptWindow,
        )
        return Promise.resolve(true)
      },
      postPatch: (patch) => {
        const parsed = transcriptPatchSchema.parse(patch) as TranscriptPatch
        patches.push(parsed)
        state.current = installTranscriptPatch(state.current, parsed)
        pendingAcks.push({ sessionId: parsed.sessionId, revision: parsed.revision })
        return Promise.resolve(true)
      },
    })
    const acknowledgeAll = (): void => {
      for (const ack of pendingAcks.splice(0)) service.acknowledge(ack.sessionId, ack.revision)
    }

    const generation = service.begin(SESSION)
    service.installPage(
      SESSION,
      {
        events: [
          {
            sequence: 1,
            time: new Date(0).toISOString(),
            event: {
              type: 'message.user',
              sessionId: SESSION,
              messageId: 'u0',
              markdown: 'please write a long report',
            },
          },
        ],
        hasMore: false,
      },
      generation,
    )

    let sequence = 2
    await accept(service, { type: 'turn.started', sessionId: SESSION, turn: 1, sequence })
    sequence += 1
    await accept(service, {
      type: 'step.started',
      sessionId: SESSION,
      turn: 1,
      step: 1,
      time: Date.now(),
      sequence,
    })
    sequence += 1

    // Stream 128KB in irregular chunks; interleave reasoning deltas and a tool.
    const chunks = [2048, 64, 4096, 512, 8192, 256]
    const streamed: string[] = []
    const reasoningStreamed: string[] = []
    let index = 0
    while (index < 60) {
      const chunk = prose(chunks[index % chunks.length] ?? 512, 7 + index)
      streamed.push(chunk)
      await accept(service, {
        type: 'message.delta',
        sessionId: SESSION,
        messageId: 'm1',
        delta: chunk,
        turn: 1,
        step: 1,
        time: Date.now(),
        sequence,
      })
      sequence += 1
      if (index % 4 === 1) {
        const reasoningChunk = prose(128, 31 + index)
        reasoningStreamed.push(reasoningChunk)
        await accept(service, {
          type: 'reasoning.delta',
          sessionId: SESSION,
          messageId: 'm1',
          delta: reasoningChunk,
          turn: 1,
          step: 1,
          time: Date.now(),
          sequence,
        })
        sequence += 1
      }
      if (index === 20) {
        await accept(service, {
          type: 'tool.updated',
          sessionId: SESSION,
          sequence,
          tool: {
            id: 'tool-1',
            turn: 1,
            step: 1,
            name: 'read_file',
            category: 'tool',
            title: 'read_file',
            status: 'running',
            inputSummary: 'report.md',
            metadata: {},
          },
        })
        sequence += 1
      }
      index += 1
      // Withhold acknowledgements past the 64-credit window so later deltas
      // coalesce into one publish: the shipped suffix must then span several
      // deltas, which only works if the pending-append tracking is exact.
    }
    acknowledgeAll()

    const fullText = streamed.join('')
    const fullReasoning = reasoningStreamed.join('')

    await accept(service, {
      type: 'message.completed',
      sessionId: SESSION,
      messageId: 'm1',
      markdown: fullText,
      reasoning: fullReasoning,
      turn: 1,
      step: 1,
      usage: { inputTokens: 10, outputTokens: 10 },
      time: Date.now(),
      sequence,
    })
    sequence += 1
    await accept(service, {
      type: 'turn.ended',
      sessionId: SESSION,
      turn: 1,
      reason: 'completed',
      sequence,
    })
    acknowledgeAll()

    // The renderer's resident window must hold the authoritative content.
    const window = state.current.transcript
    expect(window).toBeDefined()
    expect(window?.sessionId).toBe(SESSION)
    const ids = (window?.nodes ?? []).map((node) => node.id)
    expect(ids[0]).toBe('u0')
    expect(ids).toContain('tool-1')
    const assistant = window?.nodes.find((node) => node.id === 'm1')
    expect(assistant).toBeDefined()
    expect(assistant?.kind).toBe('assistant-message')
    if (assistant?.kind !== 'assistant-message') return
    expect(assistant.markdown).toBe(fullText)
    expect(assistant.reasoning?.markdown).toBe(fullReasoning)
    expect(assistant.streaming).toBe(false)
    expect(window?.lastSequence).toBe(sequence)

    expect(window?.eventFacts.at(-1)?.sequence).toBe(sequence)

    // Coalescing proof: at least one text update must carry a suffix longer
    // than any single chunk (several deltas merged into one publish).
    const coalesced = patches.some((patch) =>
      (patch.textUpdates ?? []).some(
        (update) => update.node.kind === 'assistant-message' && update.node.markdown.length > 8192,
      ),
    )
    expect(coalesced).toBe(true)
    service.dispose()
  })

  it('transient baseline restart and completed replacement keep the authoritative text', async () => {
    const state: { current: AppState } = {
      current: { ...createInitialState({}), activeSessionId: SESSION },
    }
    const service = new TranscriptWindowService({
      read: () => Promise.resolve({ events: [], hasMore: false }),
      publicValue: (value, cwd) => sanitizePublicValue(value, undefined, [WORKSPACE_ROOT], cwd),
      post: (window) => {
        state.current = installTranscript(
          state.current,
          transcriptWindowSchema.parse(window) as TranscriptWindow,
        )
        return Promise.resolve(true)
      },
      postPatch: (patch) => {
        const parsed = transcriptPatchSchema.parse(patch) as TranscriptPatch
        state.current = installTranscriptPatch(state.current, parsed)
        service.acknowledge(SESSION, parsed.revision)
        return Promise.resolve(true)
      },
    })
    const generation = service.begin(SESSION)
    service.installPage(SESSION, { events: [], hasMore: false }, generation)

    let sequence = 1
    await accept(service, { type: 'turn.started', sessionId: SESSION, turn: 1, sequence })
    sequence += 1

    // First attempt streams a partial body as process-local transient frames.
    await accept(service, {
      type: 'message.delta',
      sessionId: SESSION,
      messageId: 'm1',
      delta: 'first attempt partial',
      turn: 1,
      step: 1,
      transientAttemptId: 'a1',
      transientIndex: 1,
      transientSequence: 1,
      time: Date.now(),
      sequence,
    })
    sequence += 1
    await accept(service, {
      type: 'message.delta',
      sessionId: SESSION,
      messageId: 'm1',
      delta: ' more',
      turn: 1,
      step: 1,
      transientAttemptId: 'a1',
      transientIndex: 2,
      transientSequence: 2,
      time: Date.now(),
      sequence,
    })
    sequence += 1

    // A new attempt restarts the local sequence: the partial body is replaced.
    await accept(service, {
      type: 'message.delta',
      sessionId: SESSION,
      messageId: 'm1',
      delta: 'second attempt full text',
      turn: 1,
      step: 1,
      transientAttemptId: 'a2',
      transientIndex: 1,
      transientSequence: 1,
      time: Date.now(),
      sequence,
    })
    sequence += 1

    const duringStream = state.current.transcript?.nodes.find((node) => node.id === 'm1')
    expect(duringStream?.kind === 'assistant-message' && duringStream.markdown).toBe(
      'second attempt full text',
    )

    // The durable completion carries the authoritative assembled text.
    await accept(service, {
      type: 'message.completed',
      sessionId: SESSION,
      messageId: 'm1',
      markdown: 'second attempt full text',
      turn: 1,
      step: 1,
      time: Date.now(),
      sequence,
    })

    const settled = state.current.transcript?.nodes.find((node) => node.id === 'm1')
    expect(settled?.kind === 'assistant-message' && settled.markdown).toBe('second attempt full text')
    service.dispose()
  })
})
