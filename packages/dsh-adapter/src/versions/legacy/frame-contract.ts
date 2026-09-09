import { z } from 'zod'

import type { LoopbackFrameChannel, LoopbackFrameParser } from '../../loopback-api-client.js'

const sessionIdSchema = z.string().min(1)
const messageIdSchema = z.string().min(1)
const approvalIdSchema = z.string().min(1)
const rpcIdSchema = z.string()
const workspaceIdSchema = z.string().min(1)

const sessionEventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number(),
  data: z.unknown(),
  sourceEventSeqs: z.array(z.number()).optional(),
  surfaceOp: z.unknown().optional(),
})

const sessionEventRc2Schema = sessionEventSchema.extend({
  ignorable: z.literal(true).optional(),
})

const contentBlockSchema = z.looseObject({ type: z.string() })
const messageSchema = z.object({
  id: messageIdSchema,
  role: z.union([z.literal('system'), z.literal('user'), z.literal('assistant')]),
  content: z.array(contentBlockSchema),
  source: z.looseObject({ kind: z.string() }),
})

const questionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  intent: z
    .discriminatedUnion('kind', [z.object({ kind: z.literal('plan-review'), approve: z.string() })])
    .optional(),
})

const queueItemSchema = z.object({
  id: messageIdSchema,
  placement: z.union([z.literal('queued'), z.literal('steering'), z.literal('context')]),
  message: messageSchema,
})

const taskViewSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  status: z.union([
    z.literal('running'),
    z.literal('stopping'),
    z.literal('completed'),
    z.literal('killed'),
    z.literal('failed'),
  ]),
  detail: z.string().optional(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().optional(),
})

const projectionSchema = z.object({
  type: z.literal('session/projection'),
  sessionId: sessionIdSchema,
  key: z.string().min(1),
  value: z.unknown(),
  seq: z.number().int().nonnegative(),
})

const rpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
})

const streamErrorSchema = z.object({ type: z.literal('stream/error'), error: rpcErrorSchema })

const toolEventViewSchema = z.discriminatedUnion('for', [
  z.object({ for: z.literal('call'), view: z.looseObject({ card: z.string() }) }),
  z.object({ for: z.literal('result'), view: z.looseObject({ card: z.string() }) }),
])

const commonMuxFrames = [
  z.object({
    type: z.literal('session/event'),
    sessionId: sessionIdSchema,
    event: sessionEventSchema,
    view: toolEventViewSchema.optional(),
  }),
  z.object({ type: z.literal('session/subscribed'), sessionId: sessionIdSchema, lastSeq: z.number().int() }),
  z.object({
    type: z.literal('approval/requested'),
    sessionId: sessionIdSchema,
    approvalId: approvalIdSchema,
    toolName: z.string(),
    callId: z.string().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval/resolved'),
    sessionId: sessionIdSchema,
    approvalId: approvalIdSchema,
    outcome: z.union([
      z.literal('allowed-once'),
      z.literal('rejected'),
      z.literal('cancelled'),
      z.literal('unavailable'),
    ]),
  }),
  z.object({
    type: z.literal('question/requested'),
    sessionId: sessionIdSchema,
    questions: z.array(questionItemSchema).min(1),
  }),
  z.object({
    type: z.literal('question/resolved'),
    sessionId: sessionIdSchema,
    questionRpcId: rpcIdSchema,
    outcome: z.union([z.literal('answered'), z.literal('cancelled')]),
  }),
  z.object({
    type: z.literal('session/queue'),
    sessionId: sessionIdSchema,
    items: z.array(queueItemSchema),
  }),
  projectionSchema,
  streamErrorSchema,
] as const

const muxFrameRc1Schema = legacyUnion(commonMuxFrames)
const muxFrameRc2Schema = legacyUnion([
  z.object({
    type: z.literal('session/event'),
    sessionId: sessionIdSchema,
    event: sessionEventRc2Schema,
    view: toolEventViewSchema.optional(),
  }),
  ...commonMuxFrames.slice(1, 7),
  z.object({ type: z.literal('session/tasks'), sessionId: sessionIdSchema, tasks: z.array(taskViewSchema) }),
  ...commonMuxFrames.slice(7),
])

const workspaceViewSchema = z.object({
  workspaceId: workspaceIdSchema,
  path: z.string(),
  title: z.string(),
  sessionIds: z.array(sessionIdSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

const commonHostFrames = [
  z.object({
    type: z.literal('host/session-added'),
    sessionId: sessionIdSchema,
    blank: z.boolean(),
    parentSessionId: sessionIdSchema.optional(),
    origin: z.literal('subagent').optional(),
    cwd: z.string().optional(),
    agentPreset: z.string().optional(),
  }),
  z.object({ type: z.literal('host/session-removed'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('host/session-status'), sessionId: sessionIdSchema, running: z.boolean() }),
  z.object({ type: z.literal('host/agent-error'), sessionId: sessionIdSchema, message: z.string() }),
  z.object({ type: z.literal('host/workspace-changed'), workspace: workspaceViewSchema }),
  z.object({ type: z.literal('host/workspace-removed'), workspaceId: workspaceIdSchema }),
  z.object({
    type: z.literal('host/archived-sessions-changed'),
    archivedSessionIds: z.array(sessionIdSchema),
  }),
  streamErrorSchema,
] as const

const hostFrameRc1Schema = legacyUnion([
  ...commonHostFrames.slice(0, 7),
  z.object({ type: z.literal('host/commands-changed') }),
  z.object({
    type: z.literal('host/session-preset-changed'),
    sessionId: sessionIdSchema,
    agentPreset: z.string(),
  }),
  z.object({ type: z.literal('host/settings-changed'), ns: z.string() }),
  z.object({ type: z.literal('host/credentials-changed'), ref: z.string() }),
  z.object({ type: z.literal('host/models-changed') }),
  commonHostFrames[7],
])

const hostFrameRc2Schema = legacyUnion([
  ...commonHostFrames.slice(0, 7),
  z.object({ type: z.literal('host/remote-event'), event: z.string().min(1), args: z.array(z.unknown()) }),
  commonHostFrames[7],
])

/** Exact payload schemas from the 0.0.1-rc.1 and 0.0.1-rc.2 packages. */
export function createLegacyFrameParser(family: 'rc1' | 'rc2'): LoopbackFrameParser {
  const muxSchema = family === 'rc1' ? muxFrameRc1Schema : muxFrameRc2Schema
  const hostSchema = family === 'rc1' ? hostFrameRc1Schema : hostFrameRc2Schema
  return {
    parse(value: unknown, channel: LoopbackFrameChannel): unknown {
      return channel === 'mux' ? muxSchema.parse(value) : hostSchema.parse(value)
    },
  }
}

function legacyUnion(schemas: readonly z.ZodType[]): z.ZodType {
  if (schemas.length < 2) throw new Error('Legacy frame contract has too few variants.')
  return z.union(schemas as [z.ZodType, z.ZodType, ...z.ZodType[]])
}
