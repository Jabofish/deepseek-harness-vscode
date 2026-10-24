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
  let changed = 0
  if (previous?.sessionId === window.sessionId)
    while (changed < window.nodes.length && window.nodes[changed] === previous.nodes[changed]) changed++
  return {
    sessionId: window.sessionId,
    nodes: window.nodes,
    lastSequence: window.lastSequence,
    nodeChangeStart: changed,
    ...(previous?.sessionId === window.sessionId ? { nodeChangeBase: previous.nodes } : {}),
    eventCount: window.nodes.filter((node) => node.kind === 'event').length,
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
  const positions = new Map(previous.nodes.map((node, position) => [node.id, position]))
  const nodes = previous.nodes.slice()
  const previousSize = windowChars(previous)
  let chars = previousSize.nodes
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
  )
    throw new Error('Transcript patch exceeds the window budget.')
  serializedWindowChars.set(window, { nodes: chars, metadata: metadataChars })
  return installTranscript(state, window)
}
