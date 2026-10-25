import {
  TRANSCRIPT_MAX_CHARS,
  TRANSCRIPT_MAX_NODES,
  transcriptWindowSchema,
  type TranscriptPatch,
  type TranscriptWindow,
} from '@dsh-vscode/webview-protocol'
import type { TimelineNode, TimelineState } from '@dsh-vscode/timeline'
import { appendedTextNodeChars } from '@dsh-vscode/timeline'
import type { AppState } from './types.js'
import { withCurrentTodos } from './todo-state.js'

// Parsed immutable nodes keep their serialized size until their owner window
// is released. Streaming must not stringify all historical message bodies.
const serializedNodeChars = new WeakMap<TimelineNode, number>()

/**
 * Durable node positions of the transcript a patch bases on. The patch
 * protocol only replaces a known id or appends an unknown one — never removes
 * — so an inherited id→position map stays exact for the patched window and is
 * only ever grown. Streaming installs one patch per delta; rebuilding a
 * 2048-entry map per patch would turn every token into an O(window) pass.
 */
const transcriptPositions = new WeakMap<readonly TimelineNode[], Map<string, number>>()
function transcriptPositionsOf(nodes: readonly TimelineNode[]): Map<string, number> {
  let map = transcriptPositions.get(nodes)
  if (map === undefined) {
    map = new Map(nodes.map((node, position) => [node.id, position]))
    transcriptPositions.set(nodes, map)
  }
  return map
}

function nodeChars(node: TimelineNode): number {
  let chars = serializedNodeChars.get(node)
  if (chars === undefined) {
    chars = JSON.stringify(node).length
    serializedNodeChars.set(node, chars)
  }
  return chars
}

// A streamed patch only changes one node, so the resident size is carried
// forward instead of re-serializing every historical body per token.
const serializedWindowChars = new WeakMap<TranscriptWindow, { nodes: number; metadata: number }>()
function windowChars(window: TranscriptWindow): { nodes: number; metadata: number } {
  const cached = serializedWindowChars.get(window)
  if (cached !== undefined) return cached
  const { nodes, ...metadata } = window
  const chars = {
    metadata: JSON.stringify({ ...metadata, nodes: [] }).length,
    nodes: nodes.reduce((total, node) => total + nodeChars(node), 0),
  }
  serializedWindowChars.set(window, chars)
  return chars
}

export function parseTranscript(value: unknown): TranscriptWindow {
  return transcriptWindowSchema.parse(value) as TranscriptWindow
}

export function transcriptTimeline(window: TranscriptWindow, previous?: TimelineState): TimelineState {
  const sameSession = previous?.sessionId === window.sessionId
  let changed = 0
  if (sameSession)
    while (changed < window.nodes.length && window.nodes[changed] === previous.nodes[changed]) changed++
  let eventCount: number
  if (sameSession && previous.eventCount !== undefined) {
    // Only positions at or after the common prefix can differ; everything
    // before `changed` kept node identity and therefore its kind. The bound
    // covers both directions because a full window may also shrink.
    eventCount = previous.eventCount
    const scanLength = Math.max(window.nodes.length, previous.nodes.length)
    for (let index = changed; index < scanLength; index++) {
      const was = previous.nodes[index]
      if (was?.kind === 'event') eventCount -= 1
      if (window.nodes[index]?.kind === 'event') eventCount += 1
    }
  } else {
    eventCount = window.nodes.filter((node) => node.kind === 'event').length
  }
  return {
    sessionId: window.sessionId,
    nodes: window.nodes,
    lastSequence: window.lastSequence,
    nodeChangeStart: changed,
    ...(sameSession ? { nodeChangeBase: previous.nodes } : {}),
    eventCount,
    ...(window.tokenUsage === undefined ? {} : { tokenUsage: window.tokenUsage }),
    ...(window.activeTurn === undefined ? {} : { activeTurn: window.activeTurn }),
  }
}

export function installTranscript(state: AppState, window: TranscriptWindow): AppState {
  if (
    window.sessionId !== state.activeSessionId ||
    (state.transcript !== undefined && window.revision <= state.transcript.revision)
  )
    return state
  return withCurrentTodos({
    ...state,
    transcript: window,
    timeline: transcriptTimeline(window, state.timeline),
    historyHasMore: window.hasMore,
    historyBeforeSequence: window.beforeSequence,
    historyLoading: false,
  })
}

/**
 * Install a Host-authored view patch, without replaying or interpreting
 * upstream events. The Host owns node order and complete metadata replacements;
 * unchanged rows retain identity and public text suffixes require an exact base.
 */
export function installTranscriptPatch(state: AppState, patch: TranscriptPatch): AppState {
  const previous = state.transcript
  if (
    patch.sessionId !== state.activeSessionId ||
    (previous !== undefined && patch.revision <= previous.revision)
  )
    return state
  if (previous === undefined || previous.revision !== patch.baseRevision)
    throw new Error('Transcript patch has no matching window.')
  const positions = transcriptPositionsOf(previous.nodes)
  // Transfer ownership before growing the map. A retained state can be used
  // again (including on a different branch), and must rebuild its own index
  // rather than see positions appended by this patch.
  transcriptPositions.delete(previous.nodes)
  const nodes = previous.nodes.slice()
  const previousSize = windowChars(previous)
  let chars = previousSize.nodes
  try {
    for (const node of patch.changedNodes) {
      const position = positions.get(node.id)
      if (position === undefined) {
        positions.set(node.id, nodes.length)
        nodes.push(node)
        chars += nodeChars(node)
        continue
      }
      const replaced = nodes[position]
      if (replaced !== undefined) chars -= nodeChars(replaced)
      nodes[position] = node
      chars += nodeChars(node)
    }
    for (const update of patch.textUpdates ?? []) {
      const position = positions.get(update.node.id)
      const old = position === undefined ? undefined : nodes[position]
      if (
        position === undefined ||
        old?.kind !== update.node.kind ||
        !('markdown' in old) ||
        old.markdown.length !== update.markdownLength
      )
        throw new Error('Transcript text update has no matching node.')
      const node = update.node
      let next: TimelineNode = { ...node, markdown: old.markdown + node.markdown }
      if (node.kind === 'assistant-message' && node.reasoning !== undefined) {
        const reasoning = old.kind === 'assistant-message' ? (old.reasoning?.markdown ?? '') : ''
        if (reasoning.length !== update.reasoningLength)
          throw new Error('Transcript reasoning update has no matching node.')
        next = {
          ...node,
          markdown: old.markdown + node.markdown,
          reasoning: { ...node.reasoning, markdown: reasoning + node.reasoning.markdown },
        }
      } else if (update.reasoningLength !== undefined) throw new Error('Invalid transcript reasoning update.')
      const nextChars = appendedTextNodeChars(old, node, nodeChars(old))
      chars += nextChars - nodeChars(old)
      serializedNodeChars.set(next, nextChars)
      nodes[position] = next
    }
  } catch (error) {
    // A rejected patch leaves appended ids in the inherited map; the next
    // attempt must rebuild it from the base window instead of trusting the
    // dirty view.
    transcriptPositions.delete(previous.nodes)
    throw error
  }
  const window: TranscriptWindow = {
    ...(patch.metadata === undefined
      ? previous
      : { sessionId: previous.sessionId, revision: patch.revision, ...patch.metadata }),
    sessionId: patch.sessionId,
    revision: patch.revision,
    ...(patch.lastSequence === undefined ? {} : { lastSequence: patch.lastSequence }),
    ...(patch.hasMore === undefined ? {} : { hasMore: patch.hasMore }),
    ...(patch.activeTurn === undefined ? {} : { activeTurn: patch.activeTurn }),
    ...(patch.tokenUsage === undefined ? {} : { tokenUsage: patch.tokenUsage }),
    nodes,
  }
  const { nodes: _nodes, ...metadata } = window
  void _nodes
  // Scalar-only patches (the streaming fast path) adjust the known metadata
  // length by the digits their scalars gained instead of re-serializing the
  // whole bounded fact metadata per patch.
  const scalarOnly =
    patch.metadata === undefined &&
    patch.hasMore === undefined &&
    patch.activeTurn === undefined &&
    patch.tokenUsage === undefined
  const metadataChars = scalarOnly
    ? previousSize.metadata +
      String(patch.revision).length -
      String(previous.revision).length +
      (patch.lastSequence === undefined
        ? 0
        : String(patch.lastSequence).length - String(previous.lastSequence).length)
    : JSON.stringify({ ...metadata, nodes: [] }).length
  if (
    nodes.length > TRANSCRIPT_MAX_NODES ||
    chars + metadataChars + Math.max(0, nodes.length - 1) > TRANSCRIPT_MAX_CHARS
  ) {
    // The inherited position map already carries this patch's appends; a
    // rejected patch leaves it inconsistent with the base window, so the next
    // attempt must rebuild it.
    transcriptPositions.delete(previous.nodes)
    throw new Error('Transcript patch exceeds the window budget.')
  }
  serializedWindowChars.set(window, { nodes: chars, metadata: metadataChars })
  // The mutated map now describes exactly the patched window's rows.
  transcriptPositions.set(window.nodes, positions)
  return installTranscript(state, window)
}
