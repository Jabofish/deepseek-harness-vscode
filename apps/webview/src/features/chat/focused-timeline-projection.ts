import type { DisplayTimelineNode } from './timeline-shared.js'
import { timelineSourceNodeIds } from './timeline-inspector-target.js'
import { terminalPresentationFailed } from '@dsh-vscode/domain'

export type FocusedWorkNode = Extract<
  DisplayTimelineNode,
  { readonly kind: 'assistant-message' | 'assistant-turn' | 'tool' }
>
export type FocusedAnswerNode = Exclude<FocusedWorkNode, { readonly kind: 'tool' }>
export interface FocusedTurnNode {
  readonly kind: 'focused-turn'
  readonly id: string
  readonly turn: number
  readonly nodes: readonly FocusedWorkNode[]
  readonly sourceIds: readonly string[]
  readonly foldable: boolean
  readonly answer: FocusedAnswerNode | undefined
  /** Virtual rows share one process disclosure for the continuous source run. */
  readonly processId?: string
  readonly processCount?: number
  readonly continuation?: boolean
}
export type PresentedTimelineNode = DisplayTimelineNode | FocusedTurnNode
export const FOCUSED_PROCESS_SEGMENT_SIZE = 24

function workTurn(node: DisplayTimelineNode | undefined): number | undefined {
  if (node?.kind === 'assistant-message' || node?.kind === 'assistant-turn') return node.turn
  return node?.kind === 'tool' ? node.tool.turn : undefined
}
function groupable(node: DisplayTimelineNode): node is FocusedWorkNode {
  if (workTurn(node) === undefined) return false
  // A submitted plan remains an independent, decision-relevant surface.
  return node.kind === 'tool'
    ? node.tool.submittedPlan === undefined
    : node.kind === 'assistant-message' ||
        (node.kind === 'assistant-turn' && node.tools.every((tool) => tool.tool.submittedPlan === undefined))
}
function healthy(node: FocusedWorkNode): boolean {
  if (node.kind === 'tool')
    return (
      node.tool.preparation === undefined &&
      node.tool.status === 'completed' &&
      node.tool.error === undefined &&
      node.tool.autoReviewDenial === undefined &&
      !terminalPresentationFailed(node.tool.presentation)
    )
  return (
    // Only the closing reply carries turnCompleted. Earlier settled steps
    // remain healthy; completion is checked against the final transcript tail.
    !node.streaming &&
    node.reasoning?.streaming !== true &&
    node.interrupted !== true &&
    (node.kind !== 'assistant-turn' || node.tools.every(healthy))
  )
}

interface TurnState {
  readonly first: number
  last: number
  healthy: boolean
  closed: boolean
}

function turnStates(nodes: readonly DisplayTimelineNode[]): Map<number, TurnState> {
  const turns = new Map<number, TurnState>()
  nodes.forEach((node, index) => {
    const turn = node.kind === 'turn-terminal' ? node.turn : workTurn(node)
    if (turn === undefined) return
    const state = turns.get(turn) ?? { first: index, last: index, healthy: true, closed: false }
    state.last = index
    if (node.kind === 'turn-terminal') state.healthy = false
    else if (groupable(node)) {
      state.healthy &&= healthy(node)
      state.closed ||= node.kind !== 'tool' && node.turnCompleted === true
    } else state.healthy = false
    turns.set(turn, state)
  })
  return turns
}

/** Bounded segments preserve row virtualization even for one very long Turn. */
export function createFocusedTimelineProjector(): (
  nodes: readonly DisplayTimelineNode[],
) => readonly PresentedTimelineNode[] {
  let previous:
    | {
        readonly source: readonly DisplayTimelineNode[]
        readonly rows: readonly PresentedTimelineNode[]
        readonly starts: readonly number[]
        readonly turns: ReadonlyMap<number, TurnState>
      }
    | undefined
  return (nodes) => {
    if (previous?.source === nodes) return previous.rows
    let common = 0
    if (previous !== undefined)
      while (
        common < nodes.length &&
        common < previous.source.length &&
        nodes[common] === previous.source[common]
      )
        common++
    const turns = turnStates(nodes)
    // A later live/error node can change every bounded segment of its Turn.
    // Revisit that Turn without invalidating older, unrelated history.
    for (const [turn, state] of turns) {
      const before = previous?.turns.get(turn)
      if (
        before !== undefined &&
        (before.last !== state.last || before.healthy !== state.healthy || before.closed !== state.closed)
      )
        common = Math.min(common, state.first)
    }
    // Revisit the last unchanged segment too: a new boundary can finalize its answer.
    let stableRows = 0
    if (previous !== undefined)
      while (stableRows + 1 < previous.starts.length && previous.starts[stableRows + 1]! < common)
        stableRows++
    const start = previous?.starts[stableRows] ?? 0
    const rows: PresentedTimelineNode[] = previous?.rows.slice(0, stableRows) ?? []
    const starts: number[] = previous?.starts.slice(0, stableRows) ?? []
    for (let index = start; index < nodes.length;) {
      const node = nodes[index]!
      if (!groupable(node)) {
        starts.push(index)
        rows.push(node)
        index++
        continue
      }
      const turn = workTurn(node)!
      const state = turns.get(turn)!
      let runStart = index
      while (runStart > 0 && groupable(nodes[runStart - 1]!) && workTurn(nodes[runStart - 1]) === turn)
        runStart--
      let runEnd = index + 1
      while (runEnd < nodes.length && groupable(nodes[runEnd]!) && workTurn(nodes[runEnd]) === turn) runEnd++
      const uninterrupted = state.first >= runStart && state.last < runEnd
      const runLast = nodes[runEnd - 1]!
      const finalReply =
        groupable(runLast) &&
        runLast.kind !== 'tool' &&
        (runLast.kind !== 'assistant-turn' || runLast.tools.length === 0) &&
        !nodes
          .slice(runStart, runEnd)
          .some(
            (member) =>
              member.kind === 'tool' &&
              (runLast.step === undefined ||
                member.tool.step === undefined ||
                member.tool.step === runLast.step),
          ) &&
        (runLast.markdown.trim() !== '' || (runLast.images?.length ?? 0) > 0)
          ? runLast
          : undefined
      // If step coordinates cannot establish a final reply, retain visible work.
      const foldable =
        state.closed &&
        state.healthy &&
        uninterrupted &&
        (finalReply?.turnCompleted === true || runLast.kind === 'tool')
      const processId = `focused-turn:${nodes[runStart]!.id}`
      const processCount = runEnd - runStart - (foldable && finalReply !== undefined ? 1 : 0)
      while (index < runEnd) {
        const continuation = index !== runStart
        starts.push(index)
        const members = nodes
          .slice(index, Math.min(runEnd, index + FOCUSED_PROCESS_SEGMENT_SIZE))
          .filter(groupable)
        index += members.length
        const first = members[0]!
        // DSH's final reply is the latest finalized step with no tool calls.
        const answer = foldable && index === runEnd ? finalReply : undefined
        rows.push({
          kind: 'focused-turn',
          id: `focused-turn:${first.id}`,
          turn,
          nodes: members,
          sourceIds: members.flatMap(timelineSourceNodeIds),
          foldable,
          answer,
          processId,
          processCount,
          continuation,
        })
      }
    }
    previous = { source: nodes, rows, starts, turns }
    return rows
  }
}

export function presentedSourceNodeIds(node: PresentedTimelineNode): readonly string[] {
  return node.kind === 'focused-turn' ? node.sourceIds : timelineSourceNodeIds(node)
}
