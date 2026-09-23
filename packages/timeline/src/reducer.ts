import { settledToolPresentation, type BackendEvent } from '@dsh-vscode/domain'

import type { AssistantTiming, ModelRetryNode, TimelineNode, TimelineState } from './nodes.js'
import { addTokenUsage } from './usage.js'

const EMPTY_STEP_TIMINGS: Readonly<Record<string, AssistantTiming>> = Object.freeze({})
const EMPTY_COMMAND_MODES: Readonly<Record<string, 'plan' | 'permission'>> = Object.freeze({})
const EMPTY_CLOSED_TURNS: ReadonlySet<number> = new Set()

type TransientDeltaEvent = Extract<BackendEvent, { readonly type: 'message.delta' | 'reasoning.delta' }>
type LiveTimelineNode = Extract<TimelineNode, { readonly kind: 'assistant-message' | 'reasoning' }>

function isTransientBaselineRestart(event: TransientDeltaEvent, node: LiveTimelineNode): boolean {
  // A fresh versioned Session follow subscription restarts its local transient
  // sequence at one. The first frame must replace the previous partial
  // projection for the same attempt instead of being dropped as a duplicate.
  return (
    event.transientAttemptId !== undefined &&
    event.transientSequence === 1 &&
    node.liveAttemptId === event.transientAttemptId &&
    node.liveLastIndex !== undefined
  )
}

function transientNodeIdentity(event: TransientDeltaEvent):
  | {
      readonly liveAttemptId: string
      readonly liveLastIndex: number
      readonly liveStartedAfterSequence?: number
    }
  | Record<never, never> {
  if (event.transientAttemptId === undefined || event.transientIndex === undefined) return {}
  return {
    liveAttemptId: event.transientAttemptId,
    liveLastIndex: event.transientIndex,
    ...(event.transientStartedAfterSequence === undefined
      ? {}
      : { liveStartedAfterSequence: event.transientStartedAfterSequence }),
  }
}

export interface SequencedBackendEvent {
  readonly sequence: number
  readonly event: BackendEvent
  /** Host-only notices do not belong to the durable DSH sequence space. */
  readonly advanceSequence?: boolean
}

/**
 * DSH reserves source.kind === "user" for a direct user turn. Other durable
 * user/message records (agent instructions, plugin snapshots, injected
 * context, and future host-owned sources) are model context rather than user
 * conversation turns and must not become visible chat bubbles.
 *
 * Keep this decision on structured source metadata. Never inspect the message
 * body: injected instructions can contain ordinary user-like text, and a real
 * user prompt can mention the same markers.
 */
export function isInjectedUserMessage(
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  const source = event.source?.trim().toLowerCase()
  return source !== undefined && source !== 'user'
}

interface ReduceTimelineOptions {
  /**
   * Internal history-replay hook. The caller owns this mutable working array
   * and never exposes an intermediate reducer state to consumers.
   */
  readonly mutableNodes?: () => TimelineNode[]
}

export function reduceTimeline(
  state: TimelineState,
  input: SequencedBackendEvent,
  options: ReduceTimelineOptions = {},
): TimelineState {
  if (input.advanceSequence !== false && input.sequence <= state.lastSequence) return state
  const event = input.event
  const sessionId = eventSessionId(input.event)
  if (state.sessionId !== undefined && sessionId !== undefined && sessionId !== state.sessionId)
    // Events for another open session are buffered by the Webview store and
    // replayed after that session's history baseline is installed.  They must
    // not advance the active session's sequence cursor: doing so can cause a
    // failed/stale open to drop later events for the session still on screen.
    return state
  const nodesMayChange = eventMayChangeTimelineNodes(event, state)
  const nodes = nodesMayChange ? (options.mutableNodes?.() ?? [...state.nodes]) : []
  let stepTimings: Record<string, AssistantTiming> | undefined
  let commandModes: Record<string, 'plan' | 'permission'> | undefined
  let activeTurn = state.activeTurn
  let closedTurns: Set<number> | undefined
  let eventCount = state.eventCount
  let nodeChangeStart: number | undefined = nodesMayChange ? undefined : state.nodeChangeStart
  const readStepTimings = (): Readonly<Record<string, AssistantTiming>> =>
    stepTimings ?? state.stepTimings ?? EMPTY_STEP_TIMINGS
  const ensureStepTimings = (): Record<string, AssistantTiming> => {
    if (stepTimings === undefined) stepTimings = { ...(state.stepTimings ?? EMPTY_STEP_TIMINGS) }
    return stepTimings
  }
  const readCommandModes = (): Readonly<Record<string, 'plan' | 'permission'>> =>
    commandModes ?? state.commandModes ?? EMPTY_COMMAND_MODES
  const ensureCommandModes = (): Record<string, 'plan' | 'permission'> => {
    if (commandModes === undefined) commandModes = { ...(state.commandModes ?? EMPTY_COMMAND_MODES) }
    return commandModes
  }
  const hasClosedTurn = (turn: number): boolean =>
    closedTurns?.has(turn) ?? state.closedTurns?.includes(turn) ?? false
  const ensureClosedTurns = (): Set<number> => {
    if (closedTurns === undefined) closedTurns = new Set(state.closedTurns ?? EMPTY_CLOSED_TURNS)
    return closedTurns
  }
  const commitTiming = (key: string | undefined, timing: AssistantTiming | undefined): void => {
    if (key === undefined || timing === undefined || timing === readStepTimings()[key]) return
    ensureStepTimings()[key] = timing
  }
  const deleteStepTiming = (key: string | undefined): void => {
    if (key === undefined || !Object.prototype.hasOwnProperty.call(readStepTimings(), key)) return
    delete ensureStepTimings()[key]
  }
  const deleteStepTimingsForTurn = (turn: number): void => {
    const prefix = `${turn}:`
    for (const key of Object.keys(readStepTimings())) if (key.startsWith(prefix)) deleteStepTiming(key)
  }
  const openTurn = (turn: number): void => {
    if (!hasClosedTurn(turn)) activeTurn = turn
  }
  switch (event.type) {
    case 'turn.started':
      if (hasClosedTurn(event.turn)) ensureClosedTurns().delete(event.turn)
      activeTurn = event.turn
      break
    case 'turn.ended':
      closeTurn(nodes, event.turn, event.reason, event.failure, input.sequence)
      if (activeTurn === event.turn) activeTurn = undefined
      if (!hasClosedTurn(event.turn)) ensureClosedTurns().add(event.turn)
      deleteStepTimingsForTurn(event.turn)
      break
    case 'message.user':
      {
        const optimisticIndex = nodes.findIndex(
          (node) =>
            node.kind === 'user-message' &&
            node.id.startsWith('optimistic:user:') &&
            // The DSH rpcId is the event-stream frame id, not the Webview
            // request id used to create the optimistic preview. Match the
            // preview text as the transport-independent fallback; ordered
            // session events keep repeated submissions FIFO.
            ((event.rpcId !== undefined && node.rpcId === event.rpcId) ||
              sameUserMessagePreview(node, event)),
        )
        if (optimisticIndex >= 0)
          nodes[optimisticIndex] = {
            kind: 'user-message',
            id: event.messageId,
            markdown: event.markdown,
            ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
            ...(event.images === undefined ? {} : { images: event.images }),
            ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
            ...(event.source === undefined ? {} : { source: event.source }),
            ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
            ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
            ...(event.sessionReferenceLabels === undefined
              ? {}
              : { sessionReferenceLabels: event.sessionReferenceLabels }),
          }
        else
          upsert(nodes, {
            kind: 'user-message',
            id: event.messageId,
            markdown: event.markdown,
            ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
            ...(event.images === undefined ? {} : { images: event.images }),
            ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
            ...(event.source === undefined ? {} : { source: event.source }),
            ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
            ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
            ...(event.sessionReferenceLabels === undefined
              ? {}
              : { sessionReferenceLabels: event.sessionReferenceLabels }),
          })
      }
      break
    case 'step.started': {
      openTurn(event.turn)
      const key = timingKey(event.turn, event.step)
      if (key !== undefined && event.time !== undefined) {
        const previous = readStepTimings()[key]
        ensureStepTimings()[key] = {
          stepStartTime: event.time,
          firstTokenTime: previous?.firstTokenTime ?? null,
          completedTime: previous?.completedTime ?? null,
        }
      }
      break
    }
    case 'message.delta': {
      if (event.turn !== undefined) openTurn(event.turn)
      const turnClosed = event.turn !== undefined && hasClosedTurn(event.turn)
      if (turnClosed && event.turn !== undefined) {
        invalidateTurnTail(nodes, event.turn)
        nodeChangeStart = 0
      }
      if (event.delta === '') break
      const timingKeyValue = timingKey(event.turn, event.step)
      const timing = noteFirstToken(readStepTimings(), event.turn, event.step, event.time)
      commitTiming(timingKeyValue, timing)
      const transient = event.transientAttemptId !== undefined && event.transientIndex !== undefined
      const index = conversationNodeIndex(nodes, event.messageId, event.turn, event.step, transient)
      nodeChangeStart = Math.min(
        nodeChangeStart ?? (index < 0 ? nodes.length : index),
        index < 0 ? nodes.length : index,
      )
      if (index < 0) {
        nodes.push({
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.delta,
          streaming: !turnClosed,
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(turnClosed ? { turnCompleted: false } : {}),
          ...(timing === undefined ? {} : { timing }),
          ...(transient ? transientNodeIdentity(event) : {}),
        })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        const baselineRestart = transient && isTransientBaselineRestart(event, node)
        if (
          transient &&
          node.liveAttemptId === event.transientAttemptId &&
          node.liveLastIndex !== undefined &&
          event.transientIndex <= node.liveLastIndex &&
          !baselineRestart
        )
          break
        const replacesPreviousAttempt =
          transient &&
          (baselineRestart ||
            (node.liveAttemptId !== undefined && node.liveAttemptId !== event.transientAttemptId))
        const nodeWithoutReasoning = { ...node }
        if (replacesPreviousAttempt) {
          delete nodeWithoutReasoning.reasoning
          delete nodeWithoutReasoning.interrupted
        }
        nodes[index] = {
          ...nodeWithoutReasoning,
          markdown: replacesPreviousAttempt ? event.delta : `${node.markdown}${event.delta}`,
          streaming: !turnClosed,
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(event.turn === undefined ? {} : { turnCompleted: false }),
          ...(timing === undefined ? {} : { timing }),
          ...(transient ? transientNodeIdentity(event) : {}),
          ...(replacesPreviousAttempt
            ? {}
            : node.reasoning === undefined
              ? {}
              : { reasoning: { ...node.reasoning, streaming: false } }),
        }
      } else if (node?.kind === 'reasoning') {
        // Older history can contain a reasoning node before the first answer
        // delta. Convert it in place so the answer can never render after a
        // separate reasoning card.
        const replacesPreviousAttempt =
          transient &&
          (isTransientBaselineRestart(event, node) ||
            (node.liveAttemptId !== undefined && node.liveAttemptId !== event.transientAttemptId))
        nodes[index] = {
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.delta,
          streaming: !turnClosed,
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(turnClosed ? { turnCompleted: false } : {}),
          ...(timing === undefined ? {} : { timing }),
          ...(transient ? transientNodeIdentity(event) : {}),
          ...(replacesPreviousAttempt ? {} : { reasoning: { markdown: node.markdown, streaming: false } }),
        }
      }
      break
    }
    case 'reasoning.delta': {
      if (event.turn !== undefined) openTurn(event.turn)
      const turnClosed = event.turn !== undefined && hasClosedTurn(event.turn)
      if (turnClosed && event.turn !== undefined) {
        invalidateTurnTail(nodes, event.turn)
        nodeChangeStart = 0
      }
      if (event.delta === '') break
      const transient = event.transientAttemptId !== undefined && event.transientIndex !== undefined
      const index = conversationNodeIndex(nodes, event.messageId, event.turn, event.step, transient)
      nodeChangeStart = Math.min(
        nodeChangeStart ?? (index < 0 ? nodes.length : index),
        index < 0 ? nodes.length : index,
      )
      // DSH counts a reasoning chunk as an answer token (`isTokenDelta` accepts
      // both text and reasoning deltas), so the step's first token - and with it
      // TTFT, which is measured from here - belongs to whichever stream produced
      // output first. Waiting for the first text delta inflates TTFT by the whole
      // reasoning phase and drops reasoning-only steps from the sample count.
      const timingKeyValue = timingKey(event.turn, event.step)
      const timing = noteFirstToken(readStepTimings(), event.turn, event.step, event.time)
      commitTiming(timingKeyValue, timing)
      if (index < 0) {
        nodes.push({
          kind: 'assistant-message',
          id: event.messageId,
          markdown: '',
          streaming: false,
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(turnClosed ? { turnCompleted: false } : {}),
          ...(timing === undefined ? {} : { timing }),
          ...(transient ? transientNodeIdentity(event) : {}),
          reasoning: { markdown: event.delta, streaming: !turnClosed },
        })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        const baselineRestart = transient && isTransientBaselineRestart(event, node)
        if (
          transient &&
          node.liveAttemptId === event.transientAttemptId &&
          node.liveLastIndex !== undefined &&
          event.transientIndex <= node.liveLastIndex &&
          !baselineRestart
        )
          break
        const replacesPreviousAttempt =
          transient &&
          (baselineRestart ||
            (node.liveAttemptId !== undefined && node.liveAttemptId !== event.transientAttemptId))
        const reasoning = node.reasoning
        const nodeWithoutInterruption = { ...node }
        if (replacesPreviousAttempt) delete nodeWithoutInterruption.interrupted
        nodes[index] = {
          ...nodeWithoutInterruption,
          ...(event.turn === undefined ? {} : { turn: event.turn }),
          ...(event.step === undefined ? {} : { step: event.step }),
          ...(replacesPreviousAttempt ? { markdown: '' } : {}),
          ...(event.turn === undefined ? {} : { turnCompleted: false }),
          ...(timing === undefined ? {} : { timing }),
          ...(transient ? transientNodeIdentity(event) : {}),
          reasoning: {
            markdown: `${replacesPreviousAttempt ? '' : (reasoning?.markdown ?? '')}${event.delta}`,
            streaming: !turnClosed,
          },
        }
      } else if (node?.kind === 'reasoning') {
        const baselineRestart = transient && isTransientBaselineRestart(event, node)
        if (
          transient &&
          node.liveAttemptId === event.transientAttemptId &&
          node.liveLastIndex !== undefined &&
          event.transientIndex <= node.liveLastIndex &&
          !baselineRestart
        )
          break
        const replacesPreviousAttempt =
          transient &&
          (baselineRestart ||
            (node.liveAttemptId !== undefined && node.liveAttemptId !== event.transientAttemptId))
        nodes[index] = {
          ...node,
          markdown: replacesPreviousAttempt ? event.delta : `${node.markdown}${event.delta}`,
          streaming: !turnClosed,
          ...(transient ? transientNodeIdentity(event) : {}),
        }
      }
      break
    }
    case 'message.completed': {
      if (event.turn !== undefined) openTurn(event.turn)
      const turnClosed = event.turn !== undefined && hasClosedTurn(event.turn)
      if (turnClosed && event.turn !== undefined) {
        invalidateTurnTail(nodes, event.turn)
        nodeChangeStart = 0
      }
      const timingKeyValue = timingKey(event.turn, event.step)
      const timing = completeTiming(readStepTimings(), event.turn, event.step, event.time)
      commitTiming(timingKeyValue, timing)
      const index = conversationNodeIndex(nodes, event.messageId, event.turn, event.step)
      nodeChangeStart = Math.min(
        nodeChangeStart ?? (index < 0 ? nodes.length : index),
        index < 0 ? nodes.length : index,
      )
      if (index < 0) {
        if (event.markdown !== undefined || event.reasoning !== undefined || event.images !== undefined)
          nodes.push({
            kind: 'assistant-message',
            id: event.messageId,
            markdown: event.markdown ?? '',
            streaming: false,
            sequence: input.sequence,
            ...(event.turn === undefined ? {} : { turn: event.turn }),
            ...(event.step === undefined ? {} : { step: event.step }),
            ...(turnClosed ? { turnCompleted: false } : {}),
            ...(timing === undefined ? {} : { timing }),
            ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(event.images === undefined ? {} : { images: event.images }),
            ...(event.interrupted === undefined ? {} : { interrupted: event.interrupted }),
            ...(event.reasoning === undefined
              ? {}
              : { reasoning: { markdown: event.reasoning, streaming: false } }),
          })
        break
      }
      const node = nodes[index]
      // An empty assistant/message is still the durable terminal boundary for
      // a step (for example a tool-only step). Keep its visible accumulator,
      // but do not treat it as the end of the surrounding turn: turn/end is
      // the only event that settles activity and branch eligibility.
      if (
        event.markdown === undefined &&
        event.reasoning === undefined &&
        event.modelLabel === undefined &&
        event.images === undefined
      ) {
        if (node?.kind === 'assistant-message')
          nodes[index] = settleAssistantNode(
            {
              ...node,
              id: event.messageId,
              streaming: false,
              sequence: input.sequence,
              ...(event.turn === undefined ? {} : { turn: event.turn }),
              ...(event.step === undefined ? {} : { step: event.step }),
              ...(turnClosed ? { turnCompleted: false } : {}),
              ...(node.reasoning === undefined ? {} : { reasoning: { ...node.reasoning, streaming: false } }),
              ...(event.usage === undefined ? {} : { usage: event.usage }),
              ...(node.images === undefined ? {} : { images: node.images }),
              ...(event.interrupted === undefined ? {} : { interrupted: event.interrupted }),
              ...(timing === undefined ? {} : { timing }),
            },
            input.advanceSequence === false,
          )
        else if (node?.kind === 'reasoning')
          nodes[index] = settleAssistantNode(
            {
              kind: 'assistant-message',
              id: event.messageId,
              markdown: '',
              streaming: false,
              sequence: input.sequence,
              ...(event.turn === undefined ? {} : { turn: event.turn }),
              ...(event.step === undefined ? {} : { step: event.step }),
              ...(turnClosed ? { turnCompleted: false } : {}),
              ...(timing === undefined ? {} : { timing }),
              ...(event.usage === undefined ? {} : { usage: event.usage }),
              ...(input.advanceSequence === false && node.liveAttemptId !== undefined
                ? {
                    liveAttemptId: node.liveAttemptId,
                    liveLastIndex: node.liveLastIndex,
                    ...(node.liveStartedAfterSequence === undefined
                      ? {}
                      : { liveStartedAfterSequence: node.liveStartedAfterSequence }),
                  }
                : {}),
              reasoning: { markdown: node.markdown, streaming: false },
            },
            input.advanceSequence === false,
          )
        break
      }
      if (node?.kind === 'assistant-message') {
        const reasoning =
          event.reasoning === undefined ? node.reasoning : { markdown: event.reasoning, streaming: false }
        nodes[index] = settleAssistantNode(
          {
            ...node,
            id: event.messageId,
            markdown: event.markdown ?? node.markdown,
            streaming: false,
            sequence: input.sequence,
            ...(event.turn === undefined ? {} : { turn: event.turn }),
            ...(event.step === undefined ? {} : { step: event.step }),
            ...(turnClosed ? { turnCompleted: false } : {}),
            ...(timing === undefined ? {} : { timing }),
            ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
            ...(event.interrupted === undefined ? {} : { interrupted: event.interrupted }),
            ...(event.usage === undefined
              ? node.usage === undefined
                ? {}
                : { usage: node.usage }
              : { usage: event.usage }),
            ...(event.images === undefined
              ? node.images === undefined
                ? {}
                : { images: node.images }
              : { images: event.images }),
            ...(reasoning === undefined ? {} : { reasoning: { ...reasoning, streaming: false } }),
          },
          input.advanceSequence === false,
        )
      } else if (node?.kind === 'reasoning') {
        nodes[index] = settleAssistantNode(
          {
            kind: 'assistant-message',
            id: event.messageId,
            markdown: event.markdown ?? '',
            streaming: false,
            sequence: input.sequence,
            ...(event.turn === undefined ? {} : { turn: event.turn }),
            ...(event.step === undefined ? {} : { step: event.step }),
            ...(turnClosed ? { turnCompleted: false } : {}),
            ...(timing === undefined ? {} : { timing }),
            ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(event.images === undefined ? {} : { images: event.images }),
            ...(event.interrupted === undefined ? {} : { interrupted: event.interrupted }),
            ...(input.advanceSequence === false && node.liveAttemptId !== undefined
              ? {
                  liveAttemptId: node.liveAttemptId,
                  liveLastIndex: node.liveLastIndex,
                  ...(node.liveStartedAfterSequence === undefined
                    ? {}
                    : { liveStartedAfterSequence: node.liveStartedAfterSequence }),
                }
              : {}),
            reasoning: {
              markdown: event.reasoning ?? node.markdown,
              streaming: false,
            },
          },
          input.advanceSequence === false,
        )
      }
      break
    }
    case 'assistant.attempt': {
      // `assistant/attempt` is the durable settlement of an intermediate
      // retry. Upstream removes the matching transient rows instead of
      // rendering them as a completed assistant message. The event has no
      // attempt id in the durable journal, so the newest open node at the
      // shared turn/step coordinate is the local equivalent of that match.
      openTurn(event.turn)
      const index = findNodeIndexFromEnd(
        nodes,
        (node) =>
          node.kind === 'assistant-message' &&
          node.turn === event.turn &&
          node.step === event.step &&
          isOpenConversationNode(node) &&
          (node.liveStartedAfterSequence === undefined || input.sequence > node.liveStartedAfterSequence),
      )
      if (index >= 0) {
        nodeChangeStart = Math.min(nodeChangeStart ?? index, index)
        nodes.splice(index, 1)
      }
      break
    }
    case 'step.ended':
      openTurn(event.turn)
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (
          node?.kind === 'assistant-message' &&
          node.turn === event.turn &&
          node.step === event.step &&
          (node.streaming || node.reasoning?.streaming === true)
        )
          nodes[index] = {
            ...node,
            streaming: false,
            sequence: input.sequence,
            ...(node.reasoning === undefined ? {} : { reasoning: { ...node.reasoning, streaming: false } }),
          }
      }
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (
          node?.kind === 'retry' &&
          node.turn === event.turn &&
          node.step === event.step &&
          node.state === 'scheduled'
        )
          nodes[index] = { ...node, state: 'cancelled' }
      }
      break
    case 'tool.updated': {
      if (event.tool.turn !== undefined) openTurn(event.tool.turn)
      if (event.tool.turn !== undefined && hasClosedTurn(event.tool.turn))
        invalidateTurnTail(nodes, event.tool.turn)
      const tool = closeLateTool(event.tool, hasClosedTurn)
      const existingIndex = findNodeIndexFromEnd(
        nodes,
        (node) => node.kind === 'tool' && node.id === event.tool.id,
      )
      const existing = existingIndex < 0 ? undefined : nodes[existingIndex]
      if (existing?.kind === 'tool') {
        nodes[existingIndex] = {
          kind: 'tool',
          id: event.tool.id,
          sequence: input.sequence,
          tool: mergeTool(existing.tool, tool),
        }
      } else upsert(nodes, { kind: 'tool', id: event.tool.id, sequence: input.sequence, tool })
      break
    }
    case 'deliverables.presented':
      upsert(nodes, {
        kind: 'deliverables',
        id: `deliverables:${event.callId}`,
        sequence: input.sequence,
        turn: event.turn,
        callId: event.callId,
        files: event.files,
      })
      break
    case 'goal.updated':
      upsert(nodes, { kind: 'goal', id: `goal:${event.sessionId}`, goals: event.goals })
      break
    case 'todo.updated':
      upsert(nodes, { kind: 'todo', id: `todo:${event.sessionId}`, todos: event.todos })
      break
    case 'compaction.updated': {
      const existingIndex = findNodeIndexFromEnd(
        nodes,
        (node) => node.kind === 'compaction' && node.id === `compaction:${event.compaction.id}`,
      )
      const existing = existingIndex < 0 ? undefined : nodes[existingIndex]
      if (existing?.kind === 'compaction') {
        nodes[existingIndex] = {
          kind: 'compaction',
          id: `compaction:${event.compaction.id}`,
          compaction: mergeCompaction(existing.compaction, event.compaction),
        }
      } else
        upsert(nodes, {
          kind: 'compaction',
          id: `compaction:${event.compaction.id}`,
          compaction: event.compaction,
        })
      break
    }
    case 'model.retry': {
      openTurn(event.retry.turn)
      if (hasClosedTurn(event.retry.turn)) invalidateTurnTail(nodes, event.retry.turn)
      const id = `retry:${event.retry.id}`
      const existingIndex = findNodeIndexFromEnd(nodes, (node) => node.kind === 'retry' && node.id === id)
      const existing = existingIndex < 0 ? undefined : nodes[existingIndex]
      const previous = existing?.kind === 'retry' ? existing : undefined
      const attempt = Math.max(event.retry.attempt, previous?.attempt ?? 0)
      const delayMs = event.retry.delayMs ?? previous?.delayMs
      const maxRetries = event.retry.maxRetries ?? previous?.maxRetries
      const message = event.retry.message ?? previous?.message
      const node: ModelRetryNode = {
        kind: 'retry',
        id,
        sequence: input.sequence,
        turn: event.retry.turn,
        step: event.retry.step,
        attempt,
        state: hasClosedTurn(event.retry.turn) ? 'cancelled' : event.retry.state,
        ...(delayMs === undefined ? {} : { delayMs }),
        ...(maxRetries === undefined ? {} : { maxRetries }),
        ...(message === undefined ? {} : { message }),
      }
      if (existingIndex < 0) nodes.push(node)
      else nodes[existingIndex] = node
      break
    }
    case 'jobs.updated':
      // `session/jobs` is a transient full snapshot rendered in the session
      // header. It is not a durable conversation event and must not create
      // timeline cards.
      break
    case 'workflow.started':
      upsert(nodes, { kind: 'workflow', id: `workflow:${event.workflow.id}`, workflow: event.workflow })
      break
    case 'workflow.member.started':
      updateWorkflow(nodes, event.runId, (workflow) => addWorkflowMember(workflow, event.phase, event.member))
      break
    case 'workflow.member.ended':
      updateWorkflow(nodes, event.runId, (workflow) =>
        settleWorkflowMember(workflow, event.seq, event.outcome),
      )
      break
    case 'workflow.ended':
      updateWorkflow(nodes, event.runId, (workflow) => ({
        ...workflow,
        status:
          event.stopReason === 'completed'
            ? 'completed'
            : event.stopReason === 'cancelled'
              ? 'cancelled'
              : 'failed',
      }))
      break
    case 'team.updated':
      upsert(nodes, teamActivityNode(nodes, event.activity))
      break
    // Requests are rendered as live interaction cards by the Webview App.
    // Projecting them into the durable timeline as notices creates a second
    // transient surface (and makes approvals look like yellow tool output).
    case 'permission.requested':
    case 'question.requested':
      break
    case 'connection.lost':
      activeTurn = undefined
      // Host-only rows are outside the durable cursor, so the Webview's own
      // replay paths (advisory snapshots, a re-open) can hand the same row to
      // the reducer twice. Key them by identity: a redelivery refreshes the
      // existing row instead of appending a second copy.
      upsert(nodes, {
        kind: 'notice',
        id: `connection:${input.sequence}`,
        level: 'error',
        text: event.reason,
      })
      break
    case 'session.gap':
      upsert(nodes, {
        kind: 'notice',
        id: `gap:${event.sessionId}:${event.fromSequence}:${event.toSequence}`,
        level: 'warning',
        text: 'Some DSH events were recovered from history or remain unavailable.',
      })
      break
    case 'permission.resolved':
    case 'question.resolved':
    case 'subagent.catalog.updated':
    case 'session.title':
    case 'session.configuration':
    case 'session.added':
    case 'session.removed':
    case 'session.subscribed':
    case 'session.projection':
    case 'session.system':
    case 'workspace.changed':
    case 'workspace.removed':
    case 'workspace.order.changed':
    case 'archived.sessions.changed':
    case 'remote.event':
      break
    case 'unknown':
      if (eventCount === undefined) eventCount = countEventNodes(state.nodes)
      if (
        insertSequencedNode(nodes, {
          kind: 'event',
          id: `event:${input.sequence}:${event.name}`,
          sequence: input.sequence,
          name: event.name,
          payload: event.payload,
        })
      )
        eventCount += 1
      break
    case 'session.status':
      break
    case 'queue.updated':
      break
    case 'notice': {
      // Command lifecycle start events are implementation details. The
      // matching command/done notice carries the useful final state and is
      // rendered on its own, so one user action produces one visible notice.
      const explicitModeName = modeCommandName(event.commandName)
      const modeName =
        explicitModeName !== undefined
          ? explicitModeName
          : event.commandId === undefined
            ? undefined
            : readCommandModes()[event.commandId]
      if (event.commandPhase === 'run' && event.commandId !== undefined && modeName !== undefined) {
        if (readCommandModes()[event.commandId] !== modeName) ensureCommandModes()[event.commandId] = modeName
      }
      const modeCommand = modeName !== undefined
      if (event.commandInput !== undefined && !modeCommand)
        upsert(nodes, {
          kind: 'command-input',
          id: `command-input:${input.sequence}`,
          text: event.commandInput,
        })
      const hideNotice = modeCommand && event.level === 'info'
      if (!hideNotice && !(event.level === 'info' && / started\.$/u.test(event.text)))
        upsert(nodes, {
          kind: 'notice',
          id: `notice:${input.sequence}`,
          level: event.level,
          text: event.text,
        })
      if (event.commandPhase === 'done' && event.commandId !== undefined) {
        if (Object.prototype.hasOwnProperty.call(readCommandModes(), event.commandId))
          delete ensureCommandModes()[event.commandId]
      }
      break
    }
  }
  if (event.type === 'message.completed' || event.type === 'step.ended') {
    const key = timingKey(event.turn, event.step)
    deleteStepTiming(key)
  }
  const tokenUsage =
    event.type === 'message.completed' && event.usage !== undefined
      ? addTokenUsage(state.tokenUsage, event.usage)
      : state.tokenUsage
  const nextCommandModes = commandModes ?? state.commandModes
  const nextStepTimings = stepTimings ?? state.stepTimings
  const nextClosedTurns = closedTurns === undefined ? state.closedTurns : [...closedTurns]
  const nextEventCount = eventCount
  const nextNodeChangeBase = nodesMayChange ? state.nodes : state.nodeChangeBase
  if (nodesMayChange && nodeChangeStart === undefined) nodeChangeStart = 0
  return {
    sessionId: state.sessionId ?? sessionId,
    nodes: nodesMayChange ? nodes : state.nodes,
    lastSequence: input.advanceSequence === false ? state.lastSequence : input.sequence,
    ...(nodeChangeStart === undefined
      ? {}
      : {
          nodeChangeStart,
          ...(nextNodeChangeBase === undefined ? {} : { nodeChangeBase: nextNodeChangeBase }),
        }),
    ...(nextEventCount === undefined ? {} : { eventCount: nextEventCount }),
    ...(nextCommandModes === undefined || Object.keys(nextCommandModes).length === 0
      ? {}
      : { commandModes: nextCommandModes }),
    ...(nextStepTimings === undefined || Object.keys(nextStepTimings).length === 0
      ? {}
      : { stepTimings: nextStepTimings }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(activeTurn === undefined ? {} : { activeTurn }),
    ...(nextClosedTurns === undefined || nextClosedTurns.length === 0
      ? {}
      : { closedTurns: nextClosedTurns }),
  }
}

/**
 * Replay a history window with one copy-on-write working array. Live callers
 * continue to use reduceTimeline's immutable one-event boundary; hydration is
 * private and does not publish any intermediate state, so copying the raw
 * node collection for every historical event is unnecessary.
 */
export function reduceTimelineBatch(
  state: TimelineState,
  inputs: readonly SequencedBackendEvent[],
): TimelineState {
  if (inputs.length === 0) return state

  let next = state
  let mutableNodes: TimelineNode[] | undefined
  const ensureMutableNodes = (): TimelineNode[] => (mutableNodes ??= [...next.nodes])
  for (const input of inputs) next = reduceTimeline(next, input, { mutableNodes: ensureMutableNodes })
  return next
}

/**
 * Keep the immutable timeline collection stable for events that only update
 * session-level state. The Webview uses this identity to skip its expensive
 * display-node projection while status, queue, and catalog notifications are
 * arriving alongside a live stream.
 */
function eventMayChangeTimelineNodes(event: BackendEvent, state: TimelineState): boolean {
  switch (event.type) {
    case 'session.status':
    case 'session.activity':
    case 'session.title':
    case 'session.configuration':
    case 'turn.started':
    case 'step.started':
    case 'session.added':
    case 'session.removed':
    case 'permission.requested':
    case 'question.requested':
    case 'permission.resolved':
    case 'question.resolved':
    case 'subagent.catalog.updated':
    case 'jobs.updated':
    case 'queue.updated':
    case 'session.subscribed':
    case 'session.projection':
    case 'session.system':
    case 'workspace.changed':
    case 'workspace.removed':
    case 'workspace.order.changed':
    case 'archived.sessions.changed':
    case 'remote.event':
      return false
    case 'message.delta':
    case 'reasoning.delta':
      return (
        event.delta !== '' || (event.turn !== undefined && state.closedTurns?.includes(event.turn) === true)
      )
    default:
      return true
  }
}

/** Plan and permission switches are control-plane state, not chat content. */
function modeCommandName(commandName: string | undefined): 'plan' | 'permission' | undefined {
  const normalized = commandName?.trim().toLocaleLowerCase()
  return normalized === 'plan' || normalized === 'permission' ? normalized : undefined
}

function timingKey(turn: number | undefined, step: number | undefined): string | undefined {
  return turn === undefined || step === undefined ? undefined : `${turn}:${step}`
}

/**
 * Close one durable turn. Assistant/message closes a model step; only this
 * boundary can settle the turn and decide whether the final visible assistant
 * is still the transcript tail that may be forked.
 */
function closeTurn(
  nodes: TimelineNode[],
  turn: number,
  reason: Extract<BackendEvent, { readonly type: 'turn.ended' }>['reason'],
  failure: Extract<BackendEvent, { readonly type: 'turn.ended' }>['failure'],
  sequence: number,
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

  if (reason !== 'completed')
    upsert(nodes, {
      kind: 'turn-terminal',
      id: `turn-terminal:${turn}`,
      turn,
      sequence,
      reason,
      ...(failure === undefined ? {} : { failure }),
    })

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
    }
  }
}

function closeLateTool(
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
function invalidateTurnTail(nodes: TimelineNode[], turn: number): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    if (node?.kind === 'assistant-message' && node.turn === turn)
      nodes[index] = { ...node, turnCompleted: false }
  }
}

function timingForEvent(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  return key === undefined ? undefined : timings[key]
}

function noteFirstToken(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined || time === undefined) return timingForEvent(timings, turn, step)
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  return previous.firstTokenTime === null ? { ...previous, firstTokenTime: time } : previous
}

function completeTiming(
  timings: Readonly<Record<string, AssistantTiming>>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined) return undefined
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  return time === undefined ? timings[key] : { ...previous, completedTime: time }
}

function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event) return event.sessionId
  if ('request' in event) return event.request.sessionId
  if ('question' in event) return event.question.sessionId
  if ('retry' in event) return event.retry.sessionId
  return undefined
}

/**
 * Compaction phases arrive as separate events sharing one id. Keep the
 * summary, replaced count, and token estimate from whichever phase last
 * carried them so the collapsed row stays informative.
 */
function mergeCompaction(
  previous: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
  next: Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'],
): Extract<TimelineNode, { readonly kind: 'compaction' }>['compaction'] {
  return {
    ...previous,
    ...next,
    phase: next.phase,
    ...(next.summary === undefined && previous.summary !== undefined ? { summary: previous.summary } : {}),
    ...(next.replacedCount === undefined && previous.replacedCount !== undefined
      ? { replacedCount: previous.replacedCount }
      : {}),
    ...(next.estimatedTokens === undefined && previous.estimatedTokens !== undefined
      ? { estimatedTokens: previous.estimatedTokens }
      : {}),
  }
}

function upsert(nodes: TimelineNode[], node: TimelineNode): void {
  const index = findNodeIndexFromEnd(nodes, (existing) => existing.id === node.id)
  if (index < 0) nodes.push(node)
  else nodes[index] = node
}

/**
 * Project one Agent Team activity onto its durable row.
 *
 * A peer message is a single stored record plus its receipt: the host appends
 * `team/message/queued` when the message is durably held, and
 * `team/message/delivered` once the target holds it — the receipt names the same
 * message id and carries no body, exactly as `team/message/delivered` is typed.
 * Keying each event by its own id showed two cards for one message: a row that
 * announced "queued" forever, and a receipt whose only text was the internal
 * `team-message-<uuid>`. Both events share the message identity, so they share
 * one row, and whichever direction they arrive in the row keeps the body and
 * sender the queued record carried while its state follows the newest fact.
 */
function teamActivityNode(
  nodes: readonly TimelineNode[],
  activity: Extract<BackendEvent, { readonly type: 'team.updated' }>['activity'],
): TimelineNode {
  if (activity.kind === 'member' || activity.kind === 'task') {
    return { kind: 'team', id: activity.id, activity }
  }
  const id = `team:message:${activity.teamId}:${activity.messageId}`
  const index = findNodeIndexFromEnd(nodes, (node) => node.id === id)
  const previous = index < 0 ? undefined : nodes[index]
  const earlier = previous?.kind === 'team' ? previous.activity : undefined
  if (earlier?.kind !== 'message.queued' && earlier?.kind !== 'message.delivered') {
    return { kind: 'team', id, activity }
  }
  const senderName = activity.senderName ?? earlier.senderName
  const delivery = activity.delivery ?? earlier.delivery
  const content = activity.content ?? earlier.content
  return {
    kind: 'team',
    id,
    activity: {
      ...activity,
      kind:
        activity.kind === 'message.delivered' || earlier.kind === 'message.delivered'
          ? 'message.delivered'
          : 'message.queued',
      ...(senderName === undefined ? {} : { senderName }),
      ...(delivery === undefined ? {} : { delivery }),
      ...(content === undefined ? {} : { content }),
    },
  }
}

/**
 * Live DSH updates target the newest node in an append-ordered transcript.
 * Keep malformed/legacy collections deterministic by returning the newest
 * matching id, which is also the reducer's unique-id invariant after upsert.
 */
function findNodeIndexFromEnd(
  nodes: readonly TimelineNode[],
  predicate: (node: TimelineNode) => boolean,
): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node !== undefined && predicate(node)) return index
  }
  return -1
}

/**
 * Unknown events are intentionally preserved, but they can be delivered after
 * a known projection has already occupied the transcript. Insert them before
 * the first later durable sequence so enabling the DSH event view does not
 * turn every future event into a block at the bottom of the conversation.
 */
function insertSequencedNode(nodes: TimelineNode[], node: TimelineNode): boolean {
  const existingIndex = nodes.findIndex((existing) => existing.id === node.id)
  if (existingIndex >= 0) {
    const existing = nodes[existingIndex]
    nodes[existingIndex] = node
    return existing?.kind !== 'event' && node.kind === 'event'
  }
  const sequence = nodeSequence(node)
  if (sequence === undefined) {
    nodes.push(node)
    return node.kind === 'event'
  }
  const laterIndex = nodes.findIndex((existing) => {
    const existingSequence = nodeSequence(existing)
    return existingSequence !== undefined && existingSequence > sequence
  })
  if (laterIndex < 0) nodes.push(node)
  else nodes.splice(laterIndex, 0, node)
  return node.kind === 'event'
}

function countEventNodes(nodes: readonly TimelineNode[]): number {
  let count = 0
  for (const node of nodes) if (node.kind === 'event') count += 1
  return count
}

function nodeSequence(node: TimelineNode): number | undefined {
  switch (node.kind) {
    case 'assistant-message':
    case 'tool':
    case 'deliverables':
    case 'retry':
    case 'turn-terminal':
    case 'event':
      return node.sequence
    default:
      return undefined
  }
}

function mergeTool(
  previous: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
  next: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
): Extract<TimelineNode, { readonly kind: 'tool' }>['tool'] {
  const merged: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'] = {
    ...previous,
    ...next,
    name: next.name === 'unknown-tool' ? previous.name : next.name,
    category: next.category === 'tool' ? previous.category : next.category,
    title: next.title === 'Tool' ? previous.title : next.title,
    ...(next.inputSummary === undefined && previous.inputSummary !== undefined
      ? { inputSummary: previous.inputSummary }
      : {}),
    ...(next.outputSummary === undefined && previous.outputSummary !== undefined
      ? { outputSummary: previous.outputSummary }
      : {}),
    metadata: { ...previous.metadata, ...next.metadata },
  }
  // The call and its result meet only here: a durable result states no name and
  // no arguments, so the card a running shell call established can be settled
  // into the card its output states only once both halves are on one row.
  const presentation = settledToolPresentation(merged.presentation, {
    name: merged.name,
    rawArguments: merged.inputSummary,
    output: merged.outputSummary,
    failed: merged.status === 'failed' || merged.error !== undefined,
    settled: merged.status === 'completed' || merged.status === 'failed' || merged.status === 'cancelled',
  })
  if (presentation === merged.presentation) return merged
  if (presentation === undefined) {
    const withoutPresentation = { ...merged }
    delete withoutPresentation.presentation
    return withoutPresentation
  }
  return { ...merged, presentation }
}

function conversationNodeIndex(
  nodes: readonly TimelineNode[],
  messageId: string,
  turn?: number,
  step?: number,
  transient = false,
): number {
  const exactIndex = findNodeIndexFromEnd(nodes, (node) => {
    if (node.id !== messageId || (node.kind !== 'assistant-message' && node.kind !== 'reasoning'))
      return false
    return !transient || isOpenConversationNode(node)
  })
  if (exactIndex >= 0 || turn === undefined || step === undefined) return exactIndex
  return findNodeIndexFromEnd(
    nodes,
    (node) =>
      node.kind === 'assistant-message' &&
      node.turn === turn &&
      node.step === step &&
      isOpenConversationNode(node),
  )
}

function isOpenConversationNode(node: TimelineNode): boolean {
  if (node.kind === 'assistant-message')
    return node.streaming || node.reasoning?.streaming === true || node.liveAttemptId !== undefined
  return node.kind === 'reasoning' && node.streaming
}

function settleAssistantNode(
  node: Extract<TimelineNode, { readonly kind: 'assistant-message' }>,
  preserveTransientIdentity: boolean,
): Extract<TimelineNode, { readonly kind: 'assistant-message' }> {
  if (preserveTransientIdentity) return node
  const settled = { ...node }
  delete settled.liveAttemptId
  delete settled.liveLastIndex
  delete settled.liveStartedAfterSequence
  return settled
}

/**
 * Whether a durable `message.user` is the message a local preview stood in for.
 *
 * The durable projection does not carry the draft's media types: images become
 * nameless durable image references, and a file the adapter inlined as a text
 * block comes back as its display name alone. Comparing the two attachment
 * lists field by field therefore never matched a message that carried anything,
 * and the user saw their own steering or subagent message twice. Correspondence
 * by kind is what identifies the message: each image the preview showed must be
 * one of the event's image references, and every other name must line up in
 * order with the event's named attachments.
 *
 * The event may also carry attachments the draft never had. Editor-context
 * chips are resolved into prompt attachments inside the Extension Host and are
 * appended after the draft's own, so the preview's names are the leading ones
 * and anything beyond them belongs to content the Webview never listed.
 */
function sameUserMessagePreview(
  node: Extract<TimelineNode, { readonly kind: 'user-message' }>,
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  if (node.markdown !== event.markdown) return false
  const previewAttachments = node.attachments ?? []
  if (previewAttachments.length === 0) return true
  const names: string[] = []
  let imageCount = 0
  for (const attachment of previewAttachments) {
    if (attachment.mimeType?.startsWith('image/') === true) imageCount += 1
    else names.push(attachment.name)
  }
  const eventNames = (event.attachments ?? []).map((attachment) => attachment.name)
  return (
    imageCount === (event.images ?? []).length &&
    names.length <= eventNames.length &&
    names.every((name, index) => name === eventNames[index])
  )
}

function workflowPhaseKey(phase: string | null): string {
  return phase === null ? 'missing' : `value:${phase.length}:${phase}`
}

function updateWorkflow(
  nodes: TimelineNode[],
  runId: string,
  update: (
    workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  ) => Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
): void {
  const index = findNodeIndexFromEnd(nodes, (node) => node.kind === 'workflow' && node.workflow.id === runId)
  const node = index < 0 ? undefined : nodes[index]
  if (node?.kind !== 'workflow') return
  nodes[index] = { ...node, workflow: update(node.workflow) }
}

function addWorkflowMember(
  workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  phase: string | null,
  member: Extract<
    TimelineNode,
    { readonly kind: 'workflow' }
  >['workflow']['stages'][number]['members'][number],
): Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'] {
  if (workflow.stages.some((stage) => stage.members.some((entry) => entry.seq === member.seq)))
    return workflow
  const id = workflowPhaseKey(phase)
  const index = workflow.stages.findIndex((stage) => stage.id === id)
  if (index < 0) return { ...workflow, stages: [...workflow.stages, { id, phase, members: [member] }] }
  const stages = [...workflow.stages]
  const stage = stages[index]
  if (stage !== undefined) stages[index] = { ...stage, members: [...stage.members, member] }
  return { ...workflow, stages }
}

function settleWorkflowMember(
  workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
  seq: number,
  outcome: 'completed' | 'failed' | 'cancelled',
): Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'] {
  return {
    ...workflow,
    stages: workflow.stages.map((stage) => ({
      ...stage,
      members: stage.members.map((member) => (member.seq === seq ? { ...member, status: outcome } : member)),
    })),
  }
}
