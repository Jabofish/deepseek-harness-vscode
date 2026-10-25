import { describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { TranscriptPatch, TranscriptWindow } from '@dsh-vscode/webview-protocol'
import { createInitialState } from './initial-state.js'
import { installTranscript, installTranscriptPatch } from './transcript-state.js'

/**
 * Streaming installs one patch per delta. With a resident window at the
 * transport ceiling, per-patch work must stay proportional to the patch (a
 * handful of nodes), not to the window: the id→position index and the event
 * count are inherited incrementally instead of being rebuilt per token.
 */

const sessionId = 'patch-throughput'

function eventWindow(nodeCount: number, revision: number): TranscriptWindow {
  const nodes: TimelineNode[] = Array.from({ length: nodeCount }, (_, index) =>
    index % 4 === 0
      ? {
          kind: 'event',
          id: `event-${index}`,
          name: `event-${index}`,
          payload: { at: index },
          sequence: index,
        }
      : {
          kind: 'assistant-message',
          id: `message-${index}`,
          markdown: `body ${index} ${'x'.repeat(64)}`,
          streaming: false,
        },
  )
  return {
    sessionId,
    revision,
    nodes,
    eventFacts: [],
    lastSequence: nodeCount,
    hasMore: false,
    historical: false,
    omittedNodeIds: [],
  }
}

describe('Transcript patch throughput at window capacity', () => {
  it('keeps per-patch cost independent of the resident window size', { tags: ['stress'] }, () => {
    let state = createInitialState({})
    state = { ...state, activeSessionId: sessionId }
    // One slot below the ceiling: the first patch appends the live node once,
    // which is what a Host-authored window leaves room for.
    const base = eventWindow(2_047, 1)
    state = installTranscript(state, base)
    expect(state.timeline.nodes).toHaveLength(2_047)
    expect(state.timeline.eventCount).toBe(Math.ceil(2_047 / 4))

    const patches = 4_000
    let nextRevision = 2
    const started = performance.now()
    for (let index = 0; index < patches; index++) {
      const streamingNode: TimelineNode = {
        kind: 'assistant-message',
        id: 'live',
        markdown: `live body ${'x'.repeat(48 + (index % 64))}`,
        streaming: true,
      }
      // The Host owns eviction: most patches replace the streaming node, and
      // the first one appends it once; rotating rows exercise position lookups
      // against the inherited index without growing the window forever.
      const rotated: TimelineNode = {
        kind: 'event',
        id: `event-${(index * 7) % 2_044}`,
        name: `event-rotated`,
        payload: { at: index },
        sequence: (index * 7) % 2_044,
      }
      const patch: TranscriptPatch = {
        sessionId,
        revision: nextRevision++,
        baseRevision: nextRevision - 2,
        changedNodes: index === 0 ? [rotated, streamingNode] : [streamingNode],
      }
      state = installTranscriptPatch(state, patch)
    }
    const perPatchMs = (performance.now() - started) / patches
    console.log(`transcript-patch 2048-node window × ${patches} patches: perPatch=${perPatchMs.toFixed(4)}ms`)
    // Window stays at the ceiling (appends push old rows out on the Host; this
    // fixture lets it grow past the ceiling only via appends, so assert the
    // accounting instead): every appended node is exactly once in the window.
    const ids = new Set(state.timeline.nodes.map((node) => node.id))
    expect(ids.size).toBe(state.timeline.nodes.length)
    expect(state.transcript?.revision).toBe(nextRevision - 1)
    // 2048-entry index rebuilds per patch measured ~0.35ms/patch on the probe
    // machine; inherited indexes sit an order of magnitude below that.
    expect(perPatchMs).toBeLessThan(0.1)
  })
})
