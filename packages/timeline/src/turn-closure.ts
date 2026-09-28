import type { BackendEvent, TurnEndFailure } from '@dsh-vscode/domain'

import type { TimelineNode, TurnTokenUsage } from './nodes.js'
import { upsert } from './node-lookup.js'

/**
 * Close one durable turn. Assistant/message closes a model step; only this
 * boundary can settle the turn and decide whether the final visible assistant
 * is still the transcript tail that may be forked.
 */
export function closeTurn(
  nodes: TimelineNode[],
  turn: number,
  reason: Extract<BackendEvent, { readonly type: 'turn.ended' }>['reason'],
  failure: Extract<BackendEvent, { readonly type: 'turn.ended' }>['failure'],
  sequence: number,
  turnUsage: TurnTokenUsage | undefined,
): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind === 'assistant-message' && node.turn === turn) {
      if (node.streaming || node.reasoning?.streaming === true)
        nodes[index] = {
          ...node,
          streaming: false,
          ...(node.sequence === undefined ? { sequence } : {}),
          ...(node.reasoning === undefined ? {} : { reasoning: { ...node.reasoning, streaming: false } }),
        }
    } else if (
      node?.kind === 'tool' &&
      node.tool.turn === turn &&
      (node.tool.status === 'queued' || node.tool.status === 'running')
    ) {
      nodes[index] = {
        ...node,
        tool: {
          ...node.tool,
          status: reason === 'error' ? 'failed' : 'cancelled',
        },
      }
    }
  }

  if (reason !== 'completed') {
    upsert(nodes, {
      kind: 'turn-terminal',
      id: `turn-terminal:${turn}`,
      turn,
      sequence,
      reason,
      ...(failure === undefined ? {} : { failure }),
    })
    if (reason === 'error' && failure !== undefined) dropNoticesMatchingFailure(nodes, failure)
  }

  let closingIndex = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind === 'assistant-message' && node.turn === turn && node.markdown.trim() !== '')
      closingIndex = index
  }

  const blockedByTerminalReason = reason === 'error' || reason === 'unknown'
  const closingNode = closingIndex < 0 ? undefined : nodes[closingIndex]
  const closingSequence = closingNode?.kind === 'assistant-message' ? closingNode.sequence : undefined
  const blockedByLaterTranscript =
    closingIndex >= 0 &&
    nodes.some((node, index) => {
      const relevant =
        (node.kind === 'assistant-message' && node.turn === turn) ||
        (node.kind === 'tool' && (node.tool.turn === undefined || node.tool.turn === turn)) ||
        (node.kind === 'retry' && node.turn === turn) ||
        (node.kind === 'deliverables' && node.turn === turn)
      if (!relevant || index === closingIndex) return false
      const nodeSequence =
        node.kind === 'assistant-message' ||
        node.kind === 'tool' ||
        node.kind === 'retry' ||
        node.kind === 'deliverables'
          ? node.sequence
          : undefined
      if (closingSequence !== undefined && nodeSequence !== undefined) return nodeSequence > closingSequence
      return index > closingIndex
    })
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind !== 'assistant-message' || node.turn !== turn) continue
    nodes[index] = {
      ...node,
      turnCompleted: index === closingIndex && !blockedByTerminalReason && !blockedByLaterTranscript,
      turnUsage: index === closingIndex && reason === 'completed' ? turnUsage : undefined,
    }
  }
}

export function closeLateTool(
  tool: Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'],
  isTurnClosed: (turn: number) => boolean,
): Extract<BackendEvent, { readonly type: 'tool.updated' }>['tool'] {
  if (
    tool.turn === undefined ||
    !isTurnClosed(tool.turn) ||
    (tool.status !== 'queued' && tool.status !== 'running')
  )
    return tool
  return { ...tool, status: 'cancelled' }
}

/** A post-turn transcript event invalidates the completed-turn action tail. */
export function invalidateTurnTail(nodes: TimelineNode[], turn: number): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind === 'assistant-message' && node.turn === turn)
      nodes[index] = { ...node, turnCompleted: false, turnUsage: undefined }
  }
}

/**
 * One upstream failure reaches the timeline through two events: the host-only
 * `agent/error` frame carries the message as an error notice, and the durable
 * `turn/end` carries the same text as the turn's failure. Only one card may
 * stay, and it is the turn row — the notice is not replayed from history, so
 * dropping it keeps a re-opened session showing what the live session shows.
 * The notice text is kept as sent while the failure text is whitespace-compacted
 * and redacted, so equality is decided on the collapsed form.
 */
function failureTextKey(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function hasTurnFailureWithText(nodes: readonly TimelineNode[], text: string): boolean {
  const key = failureTextKey(text)
  if (key === '') return false
  return nodes.some((node) => {
    if (node.kind !== 'turn-terminal' || node.reason !== 'error' || node.failure === undefined) return false
    return failureTextKey(node.failure.message) === key
  })
}

function dropNoticesMatchingFailure(nodes: TimelineNode[], failure: TurnEndFailure): void {
  const key = failureTextKey(failure.message)
  if (key === '') return
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind === 'notice' && node.level === 'error' && failureTextKey(node.text) === key)
      nodes.splice(index, 1)
  }
}
