import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_MAX_CHARS,
  transcriptWindowSchema,
  type TranscriptWindow,
  type TranscriptPatch,
} from '@dsh-vscode/webview-protocol'
import { createInitialState } from './initial-state.js'
import { installTranscript, installTranscriptPatch } from './transcript-state.js'
import type { AppState } from './types.js'

function nearLimit(markdownTail = '', spare = 0): TranscriptWindow {
  const window: TranscriptWindow = {
    sessionId: 's',
    revision: 1,
    lastSequence: 0,
    hasMore: false,
    historical: false,
    omittedNodeIds: [],
    eventFacts: [],
    nodes: [{ kind: 'assistant-message', id: 'm', markdown: markdownTail, streaming: true }],
  }
  const node = window.nodes[0]!
  if (node.kind !== 'assistant-message') throw new Error('fixture')
  return transcriptWindowSchema.parse({
    ...window,
    nodes: [
      {
        ...node,
        markdown: 'x'.repeat(TRANSCRIPT_MAX_CHARS - JSON.stringify(window).length - spare) + markdownTail,
      },
    ],
  }) as TranscriptWindow
}

function state(window: TranscriptWindow): AppState {
  return installTranscript({ ...createInitialState({}), activeSessionId: 's' }, window)
}

describe('incremental transcript budget', () => {
  it('counts changed metadata in text-update envelopes before accepting a near-limit window', () => {
    const window = nearLimit('', 1024)
    const node = window.nodes[0]!
    if (node.kind !== 'assistant-message') throw new Error('fixture')
    const patch: TranscriptPatch = {
      sessionId: 's',
      revision: 2,
      baseRevision: 1,
      changedNodes: [],
      textUpdates: [
        {
          node: {
            kind: 'assistant-message',
            id: 'm',
            markdown: '',
            streaming: false,
            modelLabel: 'm'.repeat(2048),
          },
          markdownLength: node.markdown.length,
        },
      ],
    }
    expect(() => installTranscriptPatch(state(window), patch)).toThrow('budget')
  })

  it('counts a surrogate pair split between chunks exactly at the window limit', () => {
    const window = nearLimit('\ud83d', 0)
    const node = window.nodes[0]!
    if (node.kind !== 'assistant-message') throw new Error('fixture')
    const result = installTranscriptPatch(state(window), {
      sessionId: 's',
      revision: 2,
      baseRevision: 1,
      changedNodes: [],
      textUpdates: [{ node: { ...node, markdown: '\ude00' }, markdownLength: node.markdown.length }],
    })
    expect(JSON.stringify(result.transcript).length).toBe(TRANSCRIPT_MAX_CHARS - 4)
    expect(() => transcriptWindowSchema.parse(result.transcript)).not.toThrow()
  })
})
