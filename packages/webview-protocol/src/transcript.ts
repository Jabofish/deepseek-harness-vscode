import type { TodoView } from '@dsh-vscode/domain'
import { z } from 'zod'
import type { TimelineNode } from '@dsh-vscode/timeline'
import type { TokenUsage } from '@dsh-vscode/domain'
import { id, boundedUnknown } from './request-common.js'

// Resident budgets, independent of DSH's message-count page size.
export const TRANSCRIPT_MAX_NODES = 2048
export const TRANSCRIPT_MAX_CHARS = 4 * 1024 * 1024
export const TRANSCRIPT_NODE_CHARS = 16 * 1024
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string()
const opt = text.optional()
const strings = z.array(text)
const usage = z
  .object({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count.optional(),
    cacheReadTokens: count.optional(),
    cacheWriteTokens: count.optional(),
    reasoningTokens: count.optional(),
  })
  .strict()
const image = z
  .object({
    attachmentId: id,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    bytes: count,
    width: count,
    height: count,
    name: opt,
  })
  .strict()
const images = z.array(image).optional()
const location = z.object({ path: text, line: count.optional() }).strict()
const locations = z.array(location).optional()
const diff = z.object({ path: text, oldText: text.nullable(), newText: text }).strict()
const title = { title: opt }
const presentation = z.union([
  z
    .object({
      phase: z.literal('call'),
      card: z.literal('generic'),
      ...title,
      kind: opt,
      rawInput: opt,
      content: strings.optional(),
      locations,
    })
    .strict(),
  z.object({ phase: z.literal('call'), card: z.literal('terminal'), title: text, description: opt }).strict(),
  z
    .object({
      phase: z.literal('call'),
      card: z.literal('diff'),
      title: text,
      diffs: z.array(diff),
      locations,
    })
    .strict(),
  z
    .object({ phase: z.literal('result'), card: z.literal('generic'), ...title, content: strings.optional() })
    .strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('terminal'),
      ...title,
      output: opt,
      exitCode: z.number().int().optional(),
      signal: opt,
    })
    .strict(),
  z.object({ phase: z.literal('result'), card: z.literal('diff'), ...title, diffs: z.array(diff) }).strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('search'),
      shape: z.literal('matches'),
      ...title,
      files: z.array(
        z
          .object({ path: text, matches: z.array(z.object({ lineNumber: count, line: text }).strict()) })
          .strict(),
      ),
      truncated: z.boolean(),
      total: count,
    })
    .strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('search'),
      shape: z.literal('paths'),
      ...title,
      paths: strings,
      truncated: z.boolean(),
      total: count,
    })
    .strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('read'),
      ...title,
      path: text,
      offset: count,
      lines: z.array(z.object({ number: count, text }).strict()),
      totalLines: count,
      lang: opt,
      content: strings.optional(),
    })
    .strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('web'),
      kind: z.literal('search'),
      ...title,
      sources: z.array(z.object({ url: text, title: opt, snippet: opt, publishedAt: opt }).strict()),
      answer: opt,
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      phase: z.literal('result'),
      card: z.literal('web'),
      kind: z.literal('fetch'),
      ...title,
      url: text,
      statusCode: count,
      truncated: z.boolean(),
    })
    .strict(),
])
const tool = z
  .object({
    id,
    parentCallId: opt,
    turn: count.optional(),
    step: count.optional(),
    name: text,
    category: text,
    title: text,
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    startedAt: opt,
    completedAt: opt,
    inputSummary: opt,
    outputSummary: opt,
    error: opt,
    images,
    submittedPlan: z.object({ title: text, markdown: text }).strict().optional(),
    preparation: z
      .object({
        attemptId: id,
        updateIndex: count,
        description: opt,
        filePath: opt,
        contentCharacters: count.optional(),
      })
      .strict()
      .optional(),
    autoReviewDenial: z.object({ reason: opt }).strict().optional(),
    locations,
    presentation: presentation.optional(),
    metadata: z.record(text, boundedUnknown),
  })
  .strict()
const todo = z.object({ id, content: text, status: z.enum(['pending', 'in-progress', 'completed']) }).strict()
const goal = z
  .object({
    id,
    title: text,
    status: z.enum(['pending', 'in-progress', 'completed', 'blocked']),
    activation: z.enum(['armed', 'disarmed']).optional(),
    maxGoalRounds: count.optional(),
    blockedReason: z.object({ code: text, message: text }).strict().optional(),
  })
  .strict()
const status = z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted'])
const question = z
  .object({
    id,
    prompt: text,
    detail: opt,
    header: opt,
    multiSelect: z.boolean().optional(),
    allowFreeText: z.boolean(),
    choices: z.array(z.object({ id, label: text, description: opt }).strict()).optional(),
    intent: z
      .object({ kind: z.literal('plan-review'), approve: text })
      .strict()
      .optional(),
  })
  .strict()
const transient = {
  liveAttemptId: opt,
  liveLastIndex: count.optional(),
  liveStartedAfterSequence: z.number().int().min(-1).optional(),
}
const base = { id }
export const transcriptNodeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('user-message'),
      ...base,
      markdown: text,
      images,
      rpcId: opt,
      source: opt,
      sourceForm: opt,
      sourceSummary: opt,
      attachments: z.array(z.object({ name: text, mimeType: opt }).strict()).optional(),
      sessionReferenceLabels: strings.optional(),
      questionReply: z
        .object({
          callId: id,
          questions: z.array(question),
          answers: z.array(z.object({ id, selected: strings, custom: opt }).strict()),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('assistant-message'),
      ...base,
      markdown: text,
      streaming: z.boolean(),
      sequence: count.optional(),
      turn: count.optional(),
      step: count.optional(),
      turnCompleted: z.boolean().optional(),
      turnUsage: usage.extend({ totalTokens: count }).optional(),
      modelLabel: opt,
      usage: usage.optional(),
      images,
      timing: z
        .object({
          stepStartTime: count.nullable(),
          firstTokenTime: count.nullable(),
          completedTime: count.nullable(),
        })
        .strict()
        .optional(),
      interrupted: z.literal(true).optional(),
      ...transient,
      reasoning: z.object({ markdown: text, streaming: z.boolean() }).strict().optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('reasoning'), ...base, markdown: text, streaming: z.boolean(), ...transient })
    .strict(),
  z.object({ kind: z.literal('tool'), ...base, tool, sequence: count.optional() }).strict(),
  z
    .object({
      kind: z.literal('deliverables'),
      ...base,
      sequence: count.optional(),
      turn: count,
      callId: id,
      files: z.array(z.object({ path: text, description: opt }).strict()),
    })
    .strict(),
  z.object({ kind: z.literal('goal'), ...base, goals: z.array(goal) }).strict(),
  z.object({ kind: z.literal('todo'), ...base, todos: z.array(todo) }).strict(),
  z
    .object({
      kind: z.literal('compaction'),
      ...base,
      compaction: z
        .object({
          id,
          phase: z.enum(['start', 'summary', 'prune', 'end']),
          summary: opt,
          replacedCount: count.optional(),
          estimatedTokens: count.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('retry'),
      ...base,
      sequence: count.optional(),
      turn: count,
      step: count,
      attempt: count,
      state: z.enum(['scheduled', 'started', 'cancelled']),
      delayMs: count.optional(),
      maxRetries: count.optional(),
      message: opt,
    })
    .strict(),
  z
    .object({
      kind: z.literal('workflow'),
      ...base,
      workflow: z
        .object({
          id,
          sessionId: id,
          name: text,
          status,
          stages: z.array(
            z
              .object({
                id,
                phase: text.nullable(),
                members: z.array(z.object({ seq: count, label: text, childId: id, status }).strict()),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('team'),
      ...base,
      activity: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('member'),
            id,
            teamId: id,
            memberId: id,
            name: text,
            phase: z.enum(['provisioning', 'active', 'failed']),
            error: opt,
          })
          .strict(),
        z
          .object({
            kind: z.literal('task'),
            id,
            teamId: id,
            taskId: id,
            subject: text,
            status: z.enum(['pending', 'in_progress', 'completed', 'deleted']),
            ownerId: opt,
            blockedByCount: count,
            writeScopeCount: count,
          })
          .strict(),
        z
          .object({
            kind: z.literal('message.queued'),
            id,
            teamId: id,
            messageId: id,
            senderName: opt,
            targetId: id,
            delivery: z.enum(['quiet', 'wakeup']).optional(),
            content: opt,
          })
          .strict(),
        z
          .object({
            kind: z.literal('message.delivered'),
            id,
            teamId: id,
            messageId: id,
            senderName: opt,
            targetId: id,
            delivery: z.enum(['quiet', 'wakeup']).optional(),
            content: opt,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({ kind: z.literal('notice'), ...base, level: z.enum(['info', 'warning', 'error']), text })
    .strict(),
  z.object({ kind: z.literal('command-input'), ...base, text }).strict(),
  z
    .object({
      kind: z.literal('turn-terminal'),
      ...base,
      turn: count,
      sequence: count,
      reason: z.enum(['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'unknown']),
      failure: z.object({ message: text, code: opt }).strict().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      ...base,
      sequence: count.optional(),
      name: text,
      payload: boundedUnknown,
    })
    .strict(),
])

export interface TranscriptWindow {
  readonly sessionId: string
  readonly revision: number
  readonly nodes: readonly TimelineNode[]
  readonly lastSequence: number
  readonly hasMore: boolean
  readonly beforeSequence?: number
  readonly historical: boolean
  readonly omittedNodeIds: readonly string[]
  readonly tokenUsage?: TokenUsage
  readonly activeTurn?: number
  readonly eventFacts: readonly TranscriptEventFact[]
  /** Current preview for older DSH without a native Todo projection; independent of the displayed page. */
  readonly currentTodos?: readonly TodoView[]
  readonly currentTodosOmitted?: true
}

/**
 * Host-produced incremental view replacement. A streaming revision changes one
 * node. Public text suffixes avoid resending accumulated Markdown; metadata
 * is replaced only when it changes. The Host falls back to a full window
 * whenever a change would reorder or remove nodes. Baseline mismatches always
 * reread the Host window instead of buffering or replaying patches.
 */
export interface TranscriptPatch {
  readonly sessionId: string
  readonly revision: number
  readonly baseRevision: number
  /** Changed nodes in window order; an unknown id appends at the tail. */
  readonly changedNodes: readonly TimelineNode[]
  /** Append to an already installed public view; never an upstream event stream. */
  readonly textUpdates?: readonly TranscriptTextUpdate[]
  /** Complete replacement when metadata changes; absent optional fields are cleared. */
  readonly metadata?: TranscriptMetadata
  readonly lastSequence?: number
  readonly hasMore?: boolean
  readonly activeTurn?: number
  readonly tokenUsage?: TranscriptWindow['tokenUsage']
}

export type TranscriptMetadata = Omit<TranscriptWindow, 'sessionId' | 'revision' | 'nodes'>
export interface TranscriptTextUpdate {
  /** All next-node fields, with only the new suffix in each Markdown field. */
  readonly node: Extract<TimelineNode, { kind: 'assistant-message' | 'reasoning' }>
  readonly markdownLength: number
  readonly reasoningLength?: number
}

export interface TranscriptEventFact {
  readonly id: string
  readonly type: string
  readonly sequence: number
  readonly turn?: number
  readonly step?: number
  readonly attempt?: number
  readonly representedSequences: number
}
const eventFact = z
  .object({
    id,
    type: text.max(256),
    sequence: count,
    turn: count.optional(),
    step: count.optional(),
    attempt: count.optional(),
    representedSequences: count,
  })
  .strict()

const transcriptWindowFields = {
  sessionId: id,
  revision: count,
  eventFacts: z.array(eventFact).max(TRANSCRIPT_MAX_NODES),
  currentTodos: z.array(todo).max(TRANSCRIPT_MAX_NODES).optional(),
  currentTodosOmitted: z.literal(true).optional(),
  lastSequence: z.number().int().min(-1),
  hasMore: z.boolean(),
  beforeSequence: count.optional(),
  historical: z.boolean(),
  omittedNodeIds: z.array(id).max(TRANSCRIPT_MAX_NODES),
  tokenUsage: usage.optional(),
  activeTurn: count.optional(),
}

export const transcriptWindowSchema = z
  .object({ ...transcriptWindowFields, nodes: z.array(transcriptNodeSchema).max(TRANSCRIPT_MAX_NODES) })
  .strict()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > TRANSCRIPT_MAX_CHARS)
      ctx.addIssue({ code: 'custom', message: 'Transcript window exceeds its resident budget.' })
    if (new Set(value.nodes.map((node) => node.id)).size !== value.nodes.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate transcript node.' })
  })

export const transcriptPatchSchema = z
  .object({
    sessionId: id,
    revision: count,
    baseRevision: count,
    changedNodes: z.array(transcriptNodeSchema).max(TRANSCRIPT_MAX_NODES),
    textUpdates: z
      .array(
        z
          .object({
            node: z.discriminatedUnion('kind', [
              transcriptNodeSchema.options[1],
              transcriptNodeSchema.options[2],
            ]),
            markdownLength: count.max(TRANSCRIPT_MAX_CHARS),
            reasoningLength: count.max(TRANSCRIPT_MAX_CHARS).optional(),
          })
          .strict(),
      )
      .max(TRANSCRIPT_MAX_NODES)
      .optional(),
    metadata: z
      .object({
        eventFacts: transcriptWindowFields.eventFacts,
        currentTodos: transcriptWindowFields.currentTodos,
        currentTodosOmitted: transcriptWindowFields.currentTodosOmitted,
        lastSequence: transcriptWindowFields.lastSequence,
        hasMore: transcriptWindowFields.hasMore,
        beforeSequence: transcriptWindowFields.beforeSequence,
        historical: transcriptWindowFields.historical,
        omittedNodeIds: transcriptWindowFields.omittedNodeIds,
        tokenUsage: transcriptWindowFields.tokenUsage,
        activeTurn: transcriptWindowFields.activeTurn,
      })
      .strict()
      .optional(),
    lastSequence: z.number().int().min(-1).optional(),
    hasMore: z.boolean().optional(),
    activeTurn: count.optional(),
    tokenUsage: usage.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (JSON.stringify(value).length > TRANSCRIPT_MAX_CHARS)
      ctx.addIssue({ code: 'custom', message: 'Transcript patch exceeds its resident budget.' })
    if (value.revision <= value.baseRevision)
      ctx.addIssue({ code: 'custom', message: 'Invalid transcript patch baseline.' })
    const ids = [
      ...value.changedNodes.map((node) => node.id),
      ...(value.textUpdates ?? []).map((entry) => entry.node.id),
    ]
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Invalid transcript patch nodes.' })
  })
