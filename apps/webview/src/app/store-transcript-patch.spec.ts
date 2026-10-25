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
  it('keeps position indexes isolated when retained states receive independent patches', () => {
    const before = installed()
    const first = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [assistant('m-3', 'first branch')],
    })
    const second = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [assistant('m-4', 'second branch'), assistant('m-3', 'appended after m-4')],
    })
    expect(second.transcript!.nodes.map((node) => node.id)).toEqual(['m-1', 'm-2', 'm-4', 'm-3'])
    // Continuing either branch must use that branch's own positions too.
    const continued = installTranscriptPatch(first, {
      sessionId,
      revision: 6,
      baseRevision: 5,
      changedNodes: [assistant('m-4', 'first branch tail')],
    })
    expect(continued.transcript!.nodes.map((node) => node.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4'])
    expect(before.transcript!.nodes).toHaveLength(2)
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

  it('replaces metadata atomically and clears completed-turn and legacy Todo state', () => {
    const initial = {
      ...window(),
      activeTurn: 3,
      currentTodos: [{ id: 'todo', content: 'Task', status: 'in-progress' as const }],
    }
    const before = installTranscript(
      { ...createInitialState({}), activeSessionId: sessionId },
      parseTranscript(initial),
    )
    const next = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [],
      metadata: {
        lastSequence: 20,
        eventFacts: [],
        omittedNodeIds: ['m-2'],
        hasMore: false,
        historical: false,
      },
    })
    expect(next.timeline.activeTurn).toBeUndefined()
    expect(next.transcript!.currentTodos).toBeUndefined()
    expect(next.transcript!.omittedNodeIds).toEqual(['m-2'])
    expect(next.transcript!.beforeSequence).toBeUndefined()
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
  it('replaces the changed node in place and keeps every other renderer identity', () => {
    const before = installed()
    const [first, second] = before.transcript!.nodes
    const next = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [assistant('m-2', ' world more')],
      lastSequence: 11,
    })

    expect(next.transcript!.revision).toBe(5)
    expect(next.transcript!.nodes).toHaveLength(2)
    expect(next.transcript!.nodes[0]).toBe(first)
    expect(next.transcript!.nodes[1]).not.toBe(second)
    expect(next.transcript!.nodes[1]).toMatchObject({ id: 'm-2', markdown: ' world more' })
    expect(next.transcript!.lastSequence).toBe(11)
  })

  it('appends an unknown node id at the tail', () => {
    const before = installed()
    const next = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [assistant('m-3', ' again')],
    })

    expect(next.transcript!.nodes.map((node) => node.id)).toEqual(['m-1', 'm-2', 'm-3'])
  })

  it('keeps facts, omissions and page bounds that the patch does not carry', () => {
    const before = installed()
    const next = installTranscriptPatch(before, {
      sessionId,
      revision: 5,
      baseRevision: 4,
      changedNodes: [assistant('m-1', 'Hello!')],
    })

    expect(next.transcript!.eventFacts).toEqual(before.transcript!.eventFacts)
    expect(next.transcript!.omittedNodeIds).toEqual(['omitted-1'])
    expect(next.transcript!.beforeSequence).toBe(5)
    expect(next.transcript!.hasMore).toBe(true)
  })

  it('ignores a revision that is not newer than the installed window', () => {
    const before = installed()
    const next = installTranscriptPatch(before, {
      sessionId,
      revision: 4,
      baseRevision: 3,
      changedNodes: [assistant('m-1', 'stale')],
    })
    expect(next).toBe(before)
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
