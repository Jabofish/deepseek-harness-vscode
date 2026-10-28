import { describe, expect, it } from 'vitest'

import {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MAX_NODES,
  transcriptPatchSchema,
  type TranscriptWindow,
} from '@dsh-vscode/webview-protocol'
import type { TimelineNode } from '@dsh-vscode/timeline'

import { createInitialState } from './store/initial-state.js'
import { installTranscript, installTranscriptPatch, parseTranscript } from './store/transcript-state.js'

const sessionId = 'patch-session'

function assistant(id: string, markdown: string): TimelineNode {
  return { kind: 'assistant-message', id, markdown, streaming: true, sequence: 10 }
}

function window(): TranscriptWindow {
  return {
    sessionId,
    revision: 4,
    nodes: [assistant('m-1', 'Hello'), assistant('m-2', ' world')],
    eventFacts: [{ id: 'event-10', type: 'message.completed', sequence: 10, representedSequences: 1 }],
    lastSequence: 10,
    hasMore: true,
    beforeSequence: 5,
    historical: false,
    omittedNodeIds: ['omitted-1'],
  }
}

function installed(): ReturnType<typeof installTranscript> {
  const state = { ...createInitialState({}), activeSessionId: sessionId }
  return installTranscript(state, parseTranscript(window()))
}

describe('transcript patches', () => {
  it('validates full-body versions and carries metadata-only changes through to the renderer', () => {
    const initial = { ...window(), contentVersions: { 'omitted-1': 'a'.repeat(64) } }
    const state = installTranscript(
      { ...createInitialState({}), activeSessionId: sessionId },
      parseTranscript(initial),
    )
    const { sessionId: _id, revision: _revision, nodes: _nodes, ...metadata } = initial
    void _id
    void _revision
    void _nodes
    const patch = {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [],
      metadata: { ...metadata, contentVersions: { 'omitted-1': 'b'.repeat(64) } },
    }
    expect(transcriptPatchSchema.safeParse(patch).success).toBe(true)
    const result = installTranscriptPatch(state, patch)
    expect(result.transcript!.contentVersions).toEqual({ 'omitted-1': 'b'.repeat(64) })
    expect(state.transcript!.contentVersions).toEqual({ 'omitted-1': 'a'.repeat(64) })
    for (const invalid of [{ 'omitted-1': 'private body' }, { 'omitted-1': 3 }])
      expect(
        transcriptPatchSchema.safeParse({ ...patch, metadata: { ...metadata, contentVersions: invalid } })
          .success,
      ).toBe(false)
    expect(() => parseTranscript({ ...initial, contentVersions: { 'omitted-1': 'bad' } })).toThrow()
  })

  it('appends reasoning and body independently and rejects an incorrect reasoning baseline', () => {
    const initial: TranscriptWindow = {
      ...window(),
      nodes: [
        {
          kind: 'assistant-message',
          id: 'live',
          markdown: 'Answer',
          streaming: true,
          reasoning: { markdown: 'Think', streaming: true },
        },
      ],
    }
    const before = installTranscript(
      { ...createInitialState({}), activeSessionId: sessionId },
      parseTranscript(initial),
    )
    const update = {
      node: {
        kind: 'assistant-message' as const,
        id: 'live',
        markdown: ' more',
        streaming: true,
        reasoning: { markdown: ' further', streaming: false },
      },
      markdownLength: 6,
      reasoningLength: 5,
    }
    const patch = { sessionId, revision: 5, baseRevision: 4, changedNodes: [], textUpdates: [update] }
    const next = installTranscriptPatch(before, patch)
    expect(next.transcript!.nodes[0]).toMatchObject({
      markdown: 'Answer more',
      reasoning: { markdown: 'Think further', streaming: false },
    })
    expect(() =>
      installTranscriptPatch(before, { ...patch, textUpdates: [{ ...update, reasoningLength: 4 }] }),
    ).toThrow('reasoning update')
    expect(before.transcript!.nodes[0]).toMatchObject({
      markdown: 'Answer',
      reasoning: { markdown: 'Think' },
    })
  })
  it('applies public text suffixes, preserves other rows, and rejects mismatched lengths', () => {
    const before = installed()
    const update = {
      node: assistant('m-2', '!') as Extract<TimelineNode, { kind: 'assistant-message' }>,
      markdownLength: 6,
    }
    const patch = { sessionId, revision: 5, baseRevision: 4, changedNodes: [], textUpdates: [update] }
    const next = installTranscriptPatch(before, patch)
    expect(next.transcript!.nodes[0]).toBe(before.transcript!.nodes[0])
    expect(next.transcript!.nodes[1]).toMatchObject({ markdown: ' world!' })
    expect(() =>
      installTranscriptPatch(before, { ...patch, textUpdates: [{ ...update, markdownLength: 5 }] }),
    ).toThrow('matching node')
    expect(
      transcriptPatchSchema.safeParse({ ...patch, changedNodes: [assistant('m-2', 'duplicate')] }).success,
    ).toBe(false)
  })

  it('enforces the exact combined character budget and node count after incremental updates', () => {
    const base = { ...window(), nodes: [assistant('large', '')] }
    const fill = TRANSCRIPT_MAX_CHARS - JSON.stringify(base).length
    const before = installTranscript(
      { ...createInitialState({}), activeSessionId: sessionId },
      parseTranscript({ ...base, nodes: [assistant('large', 'x'.repeat(fill))] }),
    )
    expect(() =>
      installTranscriptPatch(before, {
        sessionId,
        revision: 5,
        baseRevision: 4,
        changedNodes: [],
        textUpdates: [
          {
            node: assistant('large', 'x') as Extract<TimelineNode, { kind: 'assistant-message' }>,
            markdownLength: fill,
          },
        ],
      }),
    ).toThrow('budget')
    const full = installTranscript(
      { ...createInitialState({}), activeSessionId: sessionId },
      parseTranscript({
        ...window(),
        nodes: Array.from({ length: TRANSCRIPT_MAX_NODES }, (_, i) => assistant(String(i), '')),
      }),
    )
    expect(() =>
      installTranscriptPatch(full, {
        sessionId,
        revision: 5,
        baseRevision: 4,
        changedNodes: [assistant('extra', '')],
      }),
    ).toThrow('budget')
  })

  it('rejects a patch whose baseline is not the installed revision', () => {
    const before = installed()
    expect(() =>
      installTranscriptPatch(before, {
        sessionId,
        revision: 9,
        baseRevision: 2,
        changedNodes: [assistant('m-1', 'orphan')],
      }),
    ).toThrow('Transcript patch has no matching window.')
  })
})
