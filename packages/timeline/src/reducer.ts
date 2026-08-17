import type { BackendEvent } from '@dsh-vscode/domain'

import type { AssistantTiming, ModelRetryNode, TimelineNode, TimelineState } from './nodes.js'
import { addTokenUsage } from './usage.js'

export interface SequencedBackendEvent {
  readonly sequence: number
  readonly event: BackendEvent
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

export function reduceTimeline(state: TimelineState, input: SequencedBackendEvent): TimelineState {
  if (input.sequence <= state.lastSequence) return state
  const sessionId = eventSessionId(input.event)
  if (state.sessionId !== undefined && sessionId !== undefined && sessionId !== state.sessionId)
    // Events for another open session are buffered by the Webview store and
    // replayed after that session's history baseline is installed.  They must
    // not advance the active session's sequence cursor: doing so can cause a
    // failed/stale open to drop later events for the session still on screen.
    return state
  const nodes = [...state.nodes]
  const stepTimings: Record<string, AssistantTiming> = { ...(state.stepTimings ?? {}) }
  const event = input.event
  switch (event.type) {
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
            ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
            ...(event.source === undefined ? {} : { source: event.source }),
            ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
            ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
          }
        else
          upsert(nodes, {
            kind: 'user-message',
            id: event.messageId,
            markdown: event.markdown,
            ...(event.attachments === undefined ? {} : { attachments: event.attachments }),
            ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
            ...(event.source === undefined ? {} : { source: event.source }),
            ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
            ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
          })
      }
      break
    case 'step.started': {
      const key = timingKey(event.turn, event.step)
      if (key !== undefined && (event.time !== undefined || stepTimings[key] !== undefined)) {
        const previous = stepTimings[key]
        stepTimings[key] = {
          stepStartTime: event.time ?? previous?.stepStartTime ?? null,
          firstTokenTime: previous?.firstTokenTime ?? null,
          completedTime: previous?.completedTime ?? null,
        }
      }
      break
    }
    case 'message.delta': {
      if (event.delta === '') break
      const timing = noteFirstToken(stepTimings, event.turn, event.step, event.time)
      const index = conversationNodeIndex(nodes, event.messageId)
      if (index < 0) {
        nodes.push({
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.delta,
          streaming: true,
          ...(timing === undefined ? {} : { timing }),
        })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        nodes[index] = {
          ...node,
          markdown: `${node.markdown}${event.delta}`,
          streaming: true,
          ...(timing === undefined ? {} : { timing }),
          ...(node.reasoning === undefined ? {} : { reasoning: { ...node.reasoning, streaming: false } }),
        }
      } else if (node?.kind === 'reasoning') {
        // Older history can contain a reasoning node before the first answer
        // delta. Convert it in place so the answer can never render after a
        // separate reasoning card.
        nodes[index] = {
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.delta,
          streaming: true,
          ...(timing === undefined ? {} : { timing }),
          reasoning: { markdown: node.markdown, streaming: false },
        }
      }
      break
    }
    case 'reasoning.delta': {
      if (event.delta === '') break
      const index = conversationNodeIndex(nodes, event.messageId)
      const timing = timingForEvent(stepTimings, event.turn, event.step)
      if (index < 0) {
        nodes.push({
          kind: 'assistant-message',
          id: event.messageId,
          markdown: '',
          streaming: false,
          ...(timing === undefined ? {} : { timing }),
          reasoning: { markdown: event.delta, streaming: true },
        })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        const reasoning = node.reasoning
        nodes[index] = {
          ...node,
          ...(timing === undefined ? {} : { timing }),
          reasoning: {
            markdown: `${reasoning?.markdown ?? ''}${event.delta}`,
            streaming: true,
          },
        }
      } else if (node?.kind === 'reasoning') {
        nodes[index] = { ...node, markdown: `${node.markdown}${event.delta}`, streaming: true }
      }
      break
    }
    case 'message.completed': {
      const timing = completeTiming(stepTimings, event.turn, event.step, event.time)
      const index = conversationNodeIndex(nodes, event.messageId)
      if (index < 0) {
        if (event.markdown !== undefined || event.reasoning !== undefined)
          nodes.push({
            kind: 'assistant-message',
            id: event.messageId,
            markdown: event.markdown ?? '',
            streaming: false,
            ...(timing === undefined ? {} : { timing }),
            ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(event.reasoning === undefined
              ? {}
              : { reasoning: { markdown: event.reasoning, streaming: false } }),
          })
        break
      }
      const node = nodes[index]
      // A usage-only completion can carry accounting without visible message
      // fields. It must not close the live answer; the accumulator below still
      // consumes its usage payload, but the retained per-message usage is
      // still recorded for the Trajectory inspector.
      if (event.markdown === undefined && event.reasoning === undefined && event.modelLabel === undefined) {
        if (node?.kind === 'assistant-message' && (event.usage !== undefined || timing !== undefined))
          nodes[index] = {
            ...node,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
            ...(timing === undefined ? {} : { timing }),
          }
        break
      }
      if (node?.kind === 'assistant-message') {
        const reasoning =
          event.reasoning === undefined ? node.reasoning : { markdown: event.reasoning, streaming: false }
        nodes[index] = {
          ...node,
          markdown: event.markdown ?? node.markdown,
          streaming: false,
          ...(timing === undefined ? {} : { timing }),
          ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
          ...(event.usage === undefined
            ? node.usage === undefined
              ? {}
              : { usage: node.usage }
            : { usage: event.usage }),
          ...(reasoning === undefined ? {} : { reasoning: { ...reasoning, streaming: false } }),
        }
      } else if (node?.kind === 'reasoning') {
        nodes[index] = {
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.markdown ?? '',
          streaming: false,
          ...(timing === undefined ? {} : { timing }),
          ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
          ...(event.usage === undefined ? {} : { usage: event.usage }),
          reasoning: {
            markdown: event.reasoning ?? node.markdown,
            streaming: false,
          },
        }
      }
      break
    }
    case 'step.ended':
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index]
        if (
          node?.kind === 'retry' &&
          node.turn === event.turn &&
          node.step === event.step &&
          node.state === 'scheduled'
        )
          nodes[index] = { ...node, state: 'cancelled' }
        else if (node?.kind === 'workflow' && node.workflow.status === 'running')
          nodes[index] = {
            ...node,
            workflow: interruptWorkflow(node.workflow),
          }
      }
      break
    case 'tool.updated': {
      const existingIndex = nodes.findIndex((node) => node.kind === 'tool' && node.id === event.tool.id)
      const existing = existingIndex < 0 ? undefined : nodes[existingIndex]
      if (existing?.kind === 'tool') {
        nodes[existingIndex] = {
          kind: 'tool',
          id: event.tool.id,
          tool: mergeTool(existing.tool, event.tool),
        }
      } else upsert(nodes, { kind: 'tool', id: event.tool.id, tool: event.tool })
      break
    }
    case 'goal.updated':
      upsert(nodes, { kind: 'goal', id: `goal:${event.sessionId}`, goals: event.goals })
      break
    case 'todo.updated':
      upsert(nodes, { kind: 'todo', id: `todo:${event.sessionId}`, todos: event.todos })
      break
    case 'compaction.updated': {
      const existingIndex = nodes.findIndex(
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
      const id = `retry:${event.retry.id}`
      const existingIndex = nodes.findIndex((node) => node.kind === 'retry' && node.id === id)
      const existing = existingIndex < 0 ? undefined : nodes[existingIndex]
      const previous = existing?.kind === 'retry' ? existing : undefined
      const attempt = Math.max(event.retry.attempt, previous?.attempt ?? 0)
      const delayMs = event.retry.delayMs ?? previous?.delayMs
      const maxRetries = event.retry.maxRetries ?? previous?.maxRetries
      const message = event.retry.message ?? previous?.message
      const node: ModelRetryNode = {
        kind: 'retry',
        id,
        turn: event.retry.turn,
        step: event.retry.step,
        attempt,
        state: event.retry.state,
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
    case 'permission.requested':
      nodes.push({
        kind: 'notice',
        id: `permission:${event.request.id}`,
        level: 'warning',
        text: event.request.title,
      })
      break
    case 'question.requested':
      nodes.push({
        kind: 'notice',
        id: `question:${event.question.id}`,
        level: 'info',
        text: event.question.prompt,
      })
      break
    case 'connection.lost':
      nodes.push({ kind: 'notice', id: `connection:${input.sequence}`, level: 'error', text: event.reason })
      break
    case 'session.gap':
      nodes.push({
        kind: 'notice',
        id: `gap:${event.sessionId}:${event.fromSequence}:${event.toSequence}`,
        level: 'warning',
        text: 'Some DSH events were recovered from history or remain unavailable.',
      })
      break
    case 'permission.resolved':
    case 'question.resolved':
    case 'session.title':
    case 'session.configuration':
    case 'session.added':
    case 'session.removed':
    case 'session.subscribed':
    case 'session.projection':
    case 'workspace.changed':
    case 'workspace.removed':
    case 'workspace.order.changed':
    case 'archived.sessions.changed':
    case 'remote.event':
      break
    case 'unknown':
      nodes.push({
        kind: 'event',
        id: `event:${input.sequence}:${event.name}`,
        name: event.name,
        payload: event.payload,
      })
      break
    case 'session.status':
      break
    case 'queue.updated':
      break
    case 'notice':
      // Command lifecycle start events are implementation details. The
      // matching command/done notice carries the useful final state and is
      // rendered on its own, so one user action produces one visible notice.
      if (!(event.level === 'info' && / started\.$/u.test(event.text)))
        nodes.push({ kind: 'notice', id: `notice:${input.sequence}`, level: event.level, text: event.text })
      break
  }
  if (event.type === 'message.completed' || event.type === 'step.ended') {
    const key = timingKey(event.turn, event.step)
    if (key !== undefined) delete stepTimings[key]
  }
  const tokenUsage =
    event.type === 'message.completed' && event.usage !== undefined
      ? addTokenUsage(state.tokenUsage, event.usage)
      : state.tokenUsage
  return {
    sessionId: state.sessionId ?? sessionId,
    nodes,
    lastSequence: input.sequence,
    ...(Object.keys(stepTimings).length === 0 ? {} : { stepTimings }),
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  }
}

function timingKey(turn: number | undefined, step: number | undefined): string | undefined {
  return turn === undefined || step === undefined ? undefined : `${turn}:${step}`
}

function timingForEvent(
  timings: Record<string, AssistantTiming>,
  turn: number | undefined,
  step: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  return key === undefined ? undefined : timings[key]
}

function noteFirstToken(
  timings: Record<string, AssistantTiming>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined || time === undefined) return timingForEvent(timings, turn, step)
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  if (previous.firstTokenTime === null) timings[key] = { ...previous, firstTokenTime: time }
  return timings[key]
}

function completeTiming(
  timings: Record<string, AssistantTiming>,
  turn: number | undefined,
  step: number | undefined,
  time: number | undefined,
): AssistantTiming | undefined {
  const key = timingKey(turn, step)
  if (key === undefined) return undefined
  const previous = timings[key] ?? { stepStartTime: null, firstTokenTime: null, completedTime: null }
  if (time !== undefined) timings[key] = { ...previous, completedTime: time }
  return timings[key]
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
  const index = nodes.findIndex((existing) => existing.id === node.id)
  if (index < 0) nodes.push(node)
  else nodes[index] = node
}

function mergeTool(
  previous: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
  next: Extract<TimelineNode, { readonly kind: 'tool' }>['tool'],
): Extract<TimelineNode, { readonly kind: 'tool' }>['tool'] {
  return {
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
}

function conversationNodeIndex(nodes: readonly TimelineNode[], messageId: string): number {
  return nodes.findIndex(
    (node) => node.id === messageId && (node.kind === 'assistant-message' || node.kind === 'reasoning'),
  )
}

function sameUserMessagePreview(
  node: Extract<TimelineNode, { readonly kind: 'user-message' }>,
  event: Extract<BackendEvent, { readonly type: 'message.user' }>,
): boolean {
  if (node.markdown !== event.markdown) return false
  const previewAttachments = node.attachments ?? []
  const eventAttachments = event.attachments ?? []
  return (
    previewAttachments.length === eventAttachments.length &&
    previewAttachments.every(
      (attachment, index) =>
        attachment.name === eventAttachments[index]?.name &&
        attachment.mimeType === eventAttachments[index]?.mimeType,
    )
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
  const index = nodes.findIndex((node) => node.kind === 'workflow' && node.workflow.id === runId)
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

function interruptWorkflow(
  workflow: Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'],
): Extract<TimelineNode, { readonly kind: 'workflow' }>['workflow'] {
  return {
    ...workflow,
    status: 'interrupted',
    stages: workflow.stages.map((stage) => ({
      ...stage,
      members: stage.members.map((member) =>
        member.status === 'running' ? { ...member, status: 'interrupted' } : member,
      ),
    })),
  }
}
