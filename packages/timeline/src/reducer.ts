import { type BackendEvent } from '@dsh-vscode/domain'
import { sameTimelineValue } from './node-equality.js'

import type { ModelRetryNode, TimelineNode, TimelineState } from './nodes.js'
import { addTokenUsage } from './usage.js'
import {
  conversationNodeIndex,
  countEventNodes,
  findNodeIndexFromEnd,
  insertSequencedNode,
  isOpenConversationNode,
  settleAssistantNode,
  sameUserMessagePreview,
  upsert,
  type TimelineNodeLookup,
} from './node-lookup.js'
import { createReplayNodeIndex } from './replay-node-index.js'
import { retireToolPreviews } from './tool-preview-lifecycle.js'
import { createTurnTracking } from './turn-tracking.js'
import { mergeCompaction, mergeTool, teamActivityNode } from './node-merge.js'
import { completeTiming, noteFirstToken, timingKey } from './step-timings.js'
import { closeLateTool, closeTurn, hasTurnFailureWithText, invalidateTurnTail } from './turn-closure.js'
import { completeTurnUsage } from './usage-tracking.js'
import { addWorkflowMember, settleWorkflowMember, updateWorkflow } from './workflow-projection.js'

const EMPTY_COMMAND_MODES: Readonly<Record<string, 'plan' | 'permission'>> = Object.freeze({})

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
  readonly nodeLookup?: () => TimelineNodeLookup
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
  const nodeLookup = nodesMayChange ? options.nodeLookup?.() : undefined

  const turnTracking = createTurnTracking(state)
  const {
    readStepTimings,
    hasClosedTurn,
    readTurnUsage,
    trackTurnStart,
    trackStepStart,
    settleUsageAttempt,
    scheduleUsageRetry,
    startUsageRetry,
    closeUsageStep,
    noteStepActivity,
    invalidateTurnUsage,
    commitTiming,
    deleteStepTiming,
    deleteStepTimingsForTurn,
    openTurn,
    reopenTurn,
    recordClosedTurn,
    forgetTurnUsage,
  } = turnTracking
  let commandModes: Record<string, 'plan' | 'permission'> | undefined

  let eventCount = state.eventCount
  let nodeChangeStart: number | undefined = nodesMayChange ? undefined : state.nodeChangeStart

  const readCommandModes = (): Readonly<Record<string, 'plan' | 'permission'>> =>
    commandModes ?? state.commandModes ?? EMPTY_COMMAND_MODES
  const ensureCommandModes = (): Record<string, 'plan' | 'permission'> => {
    if (commandModes === undefined) commandModes = { ...(state.commandModes ?? EMPTY_COMMAND_MODES) }
    return commandModes
  }

  const previewChangeStart = retireToolPreviews(nodes, event)
  if (previewChangeStart !== undefined) {
    nodeChangeStart = previewChangeStart
    nodeLookup?.synchronize(previewChangeStart)
  }
  switch (event.type) {
    case 'turn.started':
      {
        const wasClosed = hasClosedTurn(event.turn)
        if (wasClosed) reopenTurn(event.turn)
        invalidateTurnTail(nodes, event.turn)
        trackTurnStart(event.turn, wasClosed)
      }
      turnTracking.activeTurn = event.turn
      break
    case 'turn.ended':
      closeTurn(
        nodes,
        event.turn,
        event.reason,
        event.failure,
        input.sequence,
        event.reason === 'completed' ? completeTurnUsage(readTurnUsage(event.turn)) : undefined,
      )
      forgetTurnUsage(event.turn)
      if (turnTracking.activeTurn === event.turn) turnTracking.activeTurn = undefined
      if (!hasClosedTurn(event.turn)) recordClosedTurn(event.turn)
      deleteStepTimingsForTurn(event.turn)
      break
    case 'message.user':
      {
        const optimisticIndex =
          nodeLookup?.optimisticUser(event) ??
          nodes.findIndex(
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
        if (optimisticIndex >= 0) {
          nodeChangeStart = Math.min(nodeChangeStart ?? optimisticIndex, optimisticIndex)
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
            ...(event.questionReply === undefined ? {} : { questionReply: event.questionReply }),
            ...(event.sessionReferenceLabels === undefined
              ? {}
              : { sessionReferenceLabels: event.sessionReferenceLabels }),
          }
        } else {
          const index = upsert(
            nodes,
            {
              kind: 'user-message',
              id: event.messageId,
              markdown: event.markdown,
              ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
              ...(event.images === undefined ? {} : { images: event.images }),
              ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
              ...(event.source === undefined ? {} : { source: event.source }),
              ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
              ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
              ...(event.questionReply === undefined ? {} : { questionReply: event.questionReply }),
              ...(event.sessionReferenceLabels === undefined
                ? {}
                : { sessionReferenceLabels: event.sessionReferenceLabels }),
            },
            nodeLookup,
          )
          nodeChangeStart = Math.min(nodeChangeStart ?? index, index)
        }
      }
      break
    case 'step.started': {
      openTurn(event.turn)
      if (hasClosedTurn(event.turn)) invalidateTurnTail(nodes, event.turn)
      trackStepStart(event.turn, event.step)
      const key = timingKey(event.turn, event.step)
      if (key !== undefined && event.time !== undefined) {
        const previous = readStepTimings()[key]
        commitTiming(key, {
          stepStartTime: event.time,
          firstTokenTime: previous?.firstTokenTime ?? null,
          completedTime: previous?.completedTime ?? null,
        })
      }
      break
    }
    case 'message.delta': {
      if (event.turn !== undefined) openTurn(event.turn)
      if (event.turn === undefined) invalidateTurnUsage(turnTracking.activeTurn)
      else noteStepActivity(event.turn, event.step)
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
      const index = conversationNodeIndex(
        nodes,
        event.messageId,
        event.turn,
        event.step,
        transient,
        nodeLookup,
      )
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
      if (event.turn === undefined) invalidateTurnUsage(turnTracking.activeTurn)
      else noteStepActivity(event.turn, event.step)
      const turnClosed = event.turn !== undefined && hasClosedTurn(event.turn)
      if (turnClosed && event.turn !== undefined) {
        invalidateTurnTail(nodes, event.turn)
        nodeChangeStart = 0
      }
      if (event.delta === '') break
      const transient = event.transientAttemptId !== undefined && event.transientIndex !== undefined
      const index = conversationNodeIndex(
        nodes,
        event.messageId,
        event.turn,
        event.step,
        transient,
        nodeLookup,
      )
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
      if (event.turn === undefined) invalidateTurnUsage(turnTracking.activeTurn)
      else settleUsageAttempt(event.turn, event.step, event.usage, 'message-settled')
      const turnClosed = event.turn !== undefined && hasClosedTurn(event.turn)
      if (turnClosed && event.turn !== undefined) {
        invalidateTurnTail(nodes, event.turn)
        nodeChangeStart = 0
      }
      const timingKeyValue = timingKey(event.turn, event.step)
      const timing = completeTiming(readStepTimings(), event.turn, event.step, event.time)
      commitTiming(timingKeyValue, timing)
      const index = conversationNodeIndex(nodes, event.messageId, event.turn, event.step, false, nodeLookup)
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
      if (hasClosedTurn(event.turn)) invalidateTurnTail(nodes, event.turn)
      settleUsageAttempt(event.turn, event.step, event.usage, 'attempt-settled')
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
      if (hasClosedTurn(event.turn)) invalidateTurnTail(nodes, event.turn)
      closeUsageStep(event.turn, event.step)
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
    case 'tool.preparing': {
      if (hasClosedTurn(event.turn)) break
      const existingIndex = findNodeIndexFromEnd(
        nodes,
        (node) => node.kind === 'tool' && node.id === event.callId,
      )
      const existing = nodes[existingIndex]
      if (
        existing?.kind === 'tool' &&
        (existing.tool.preparation === undefined ||
          (existing.tool.preparation.attemptId === event.attemptId &&
            existing.tool.preparation.updateIndex >= event.updateIndex))
      )
        break
      upsert(nodes, {
        kind: 'tool',
        id: event.callId,
        tool: {
          id: event.callId,
          name: event.toolName,
          category: 'tool',
          title: event.toolName,
          status: 'queued',
          turn: event.turn,
          step: event.step,
          metadata: {},
          preparation: {
            attemptId: event.attemptId,
            updateIndex: event.updateIndex,
            ...(event.description === undefined ? {} : { description: event.description }),
            ...(event.filePath === undefined ? {} : { filePath: event.filePath }),
            ...(event.contentCharacters === undefined ? {} : { contentCharacters: event.contentCharacters }),
          },
        },
      })
      break
    }
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
      if (event.retry.state === 'scheduled')
        scheduleUsageRetry(event.retry.turn, event.retry.step, event.retry.id, event.retry.attempt)
      else startUsageRetry(event.retry.turn, event.retry.step, event.retry.id, event.retry.attempt)
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
      turnTracking.activeTurn = undefined
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
      // A failed turn also closes with the same text as its durable failure, and
      // only that row is replayed from history, so the turn keeps the surface.
      const claimedByTurnFailure = event.level === 'error' && hasTurnFailureWithText(nodes, event.text)
      if (
        !hideNotice &&
        !claimedByTurnFailure &&
        !(event.level === 'info' && / started\.$/u.test(event.text))
      )
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
  const nextEventCount = eventCount
  const nextNodeChangeBase = nodesMayChange ? state.nodes : state.nodeChangeBase
  if (nodesMayChange && nodeChangeStart === undefined) nodeChangeStart = 0
  let unchangedNodes = nodes.length === state.nodes.length
  if (nodesMayChange && options.mutableNodes === undefined) {
    for (let index = nodeChangeStart ?? 0; index < nodes.length; index++) {
      const previous = state.nodes[index]
      if (previous !== undefined && sameTimelineValue(previous, nodes[index])) nodes[index] = previous
      else unchangedNodes = false
    }
  } else unchangedNodes = false
  return {
    sessionId: state.sessionId ?? sessionId,
    nodes: nodesMayChange && !unchangedNodes ? nodes : state.nodes,
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
    ...turnTracking.snapshot(),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
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
  let nodeIndex: TimelineNodeLookup | undefined
  const indexAccess = { used: false }
  const ensureMutableNodes = (): TimelineNode[] => (mutableNodes ??= [...next.nodes])
  const options: ReduceTimelineOptions = {
    mutableNodes: ensureMutableNodes,
    nodeLookup: () => {
      indexAccess.used = true
      return (nodeIndex ??= createReplayNodeIndex(ensureMutableNodes()))
    },
  }
  for (const input of inputs) {
    indexAccess.used = false
    next = reduceTimeline(next, input, options)
    if (indexAccess.used) nodeIndex?.synchronize(next.nodeChangeStart ?? 0)
  }
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
    case 'session.subscribed':
      return (
        event.controlBaseline === false &&
        state.nodes.some((node) => node.kind === 'tool' && node.tool.preparation !== undefined)
      )
    case 'session.status':
    case 'session.activity':
    case 'session.title':
    case 'session.configuration':
    case 'session.added':
    case 'session.removed':
    case 'permission.requested':
    case 'question.requested':
    case 'permission.resolved':
    case 'question.resolved':
    case 'subagent.catalog.updated':
    case 'jobs.updated':
    case 'queue.updated':
    case 'session.projection':
    case 'session.system':
    case 'workspace.changed':
    case 'workspace.removed':
    case 'workspace.order.changed':
    case 'archived.sessions.changed':
    case 'remote.event':
      return false
    case 'turn.started':
    case 'step.started':
      return state.closedTurns?.includes(event.turn) === true
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

function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event) return event.sessionId
  if ('request' in event) return event.request.sessionId
  if ('question' in event) return event.question.sessionId
  if ('retry' in event) return event.retry.sessionId
  return undefined
}

/** True for a retained error notice whose own transcript already shows the turn row. */
export function isRedundantTurnFailureNotice(node: TimelineNode, nodes: readonly TimelineNode[]): boolean {
  return node.kind === 'notice' && node.level === 'error' && hasTurnFailureWithText(nodes, node.text)
}
