import type { BackendEvent } from '@dsh-vscode/domain'

import type { TimelineNode, TimelineState } from './nodes.js'
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
    return { ...state, lastSequence: input.sequence }
  const nodes = [...state.nodes]
  const event = input.event
  switch (event.type) {
    case 'message.user':
      if (isInjectedUserMessage(event)) break
      {
        const optimisticIndex = nodes.findIndex(
          (node) =>
            node.kind === 'user-message' &&
            node.id.startsWith('optimistic:user:') &&
            ((event.rpcId !== undefined && node.rpcId === event.rpcId) ||
              (event.rpcId === undefined && node.markdown === event.markdown)),
        )
        if (optimisticIndex >= 0)
          nodes[optimisticIndex] = {
            kind: 'user-message',
            id: event.messageId,
            markdown: event.markdown,
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
            ...(event.rpcId === undefined ? {} : { rpcId: event.rpcId }),
            ...(event.source === undefined ? {} : { source: event.source }),
            ...(event.sourceForm === undefined ? {} : { sourceForm: event.sourceForm }),
            ...(event.sourceSummary === undefined ? {} : { sourceSummary: event.sourceSummary }),
          })
      }
      break
    case 'message.delta': {
      if (event.delta === '') break
      const index = conversationNodeIndex(nodes, event.messageId)
      if (index < 0) {
        nodes.push({ kind: 'assistant-message', id: event.messageId, markdown: event.delta, streaming: true })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        nodes[index] = {
          ...node,
          markdown: `${node.markdown}${event.delta}`,
          streaming: true,
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
          reasoning: { markdown: node.markdown, streaming: false },
        }
      }
      break
    }
    case 'reasoning.delta': {
      if (event.delta === '') break
      const index = conversationNodeIndex(nodes, event.messageId)
      if (index < 0) {
        nodes.push({
          kind: 'assistant-message',
          id: event.messageId,
          markdown: '',
          streaming: false,
          reasoning: { markdown: event.delta, streaming: true },
        })
        break
      }
      const node = nodes[index]
      if (node?.kind === 'assistant-message') {
        const reasoning = node.reasoning
        nodes[index] = {
          ...node,
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
      const index = conversationNodeIndex(nodes, event.messageId)
      if (index < 0) {
        if (event.markdown !== undefined || event.reasoning !== undefined)
          nodes.push({
            kind: 'assistant-message',
            id: event.messageId,
            markdown: event.markdown ?? '',
            streaming: false,
            ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
            ...(event.reasoning === undefined
              ? {}
              : { reasoning: { markdown: event.reasoning, streaming: false } }),
          })
        break
      }
      const node = nodes[index]
      // A usage-only completion can carry accounting without visible message
      // fields. It must not close the live answer; the accumulator below still
      // consumes its usage payload.
      if (event.markdown === undefined && event.reasoning === undefined && event.modelLabel === undefined)
        break
      if (node?.kind === 'assistant-message') {
        const reasoning =
          event.reasoning === undefined ? node.reasoning : { markdown: event.reasoning, streaming: false }
        nodes[index] = {
          ...node,
          markdown: event.markdown ?? node.markdown,
          streaming: false,
          ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
          ...(reasoning === undefined ? {} : { reasoning: { ...reasoning, streaming: false } }),
        }
      } else if (node?.kind === 'reasoning') {
        nodes[index] = {
          kind: 'assistant-message',
          id: event.messageId,
          markdown: event.markdown ?? '',
          streaming: false,
          ...(event.modelLabel === undefined ? {} : { modelLabel: event.modelLabel }),
          reasoning: {
            markdown: event.reasoning ?? node.markdown,
            streaming: false,
          },
        }
      }
      break
    }
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
    case 'compaction.updated':
      upsert(nodes, {
        kind: 'compaction',
        id: `compaction:${event.compaction.id}`,
        compaction: event.compaction,
      })
      break
    case 'job.updated':
      upsert(nodes, { kind: 'job', id: `job:${event.job.id}`, job: event.job })
      break
    case 'jobs.updated':
      for (const job of event.jobs) upsert(nodes, { kind: 'job', id: `job:${job.id}`, job })
      break
    case 'subagent.updated':
      upsert(nodes, { kind: 'subagent', id: `subagent:${event.subagent.id}`, subagent: event.subagent })
      break
    case 'workflow.updated':
      upsert(nodes, {
        kind: 'notice',
        id: `workflow:${event.workflow.id}`,
        level: workflowLevel(event.workflow.status),
        text: `Workflow ${event.workflow.name}: ${event.workflow.status}`,
      })
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
      nodes.push({ kind: 'notice', id: `notice:${input.sequence}`, level: event.level, text: event.text })
      break
  }
  const tokenUsage =
    event.type === 'message.completed' && event.usage !== undefined
      ? addTokenUsage(state.tokenUsage, event.usage)
      : state.tokenUsage
  return {
    sessionId: state.sessionId ?? sessionId,
    nodes,
    lastSequence: input.sequence,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
  }
}

function eventSessionId(event: BackendEvent): string | undefined {
  if ('sessionId' in event) return event.sessionId
  if ('request' in event) return event.request.sessionId
  if ('question' in event) return event.question.sessionId
  return undefined
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

function workflowLevel(status: string): 'info' | 'warning' | 'error' {
  if (status === 'failed') return 'error'
  if (status === 'cancelled') return 'warning'
  return 'info'
}
