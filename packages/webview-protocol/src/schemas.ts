import { z } from 'zod'

const id = z.string().min(1).max(256)
const wireVersion = z.literal(1)
const requestBase = { requestId: id }
// Historical DSH transcripts contain many structured stream events. The
// adapter compacts visible deltas before they reach this boundary, while this
// larger node budget still permits genuinely long sessions without turning a
// valid response into a protocol error. String-size limits remain unchanged.
const MAX_PROTOCOL_NODES = 100_000
const session = { sessionId: id }
const attachmentSchema = z
  .object({
    // The Extension Host owns the bytes. The Webview only sends back this
    // short-lived opaque handle, never a path or a data URI.
    uri: z.string().regex(/^dsh-attachment:[A-Za-z0-9-]{16,128}$/),
    name: z.string().min(1).max(512),
    mimeType: z.string().max(256).optional(),
  })
  .strict()
const promptSchema = z
  .object({
    sessionId: id,
    text: z.string().max(1_000_000),
    attachments: z.array(attachmentSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    let totalBytes = 0
    for (const attachment of value.attachments) {
      const match = attachment.uri.match(/^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/i)
      if (match === null) continue
      totalBytes += Math.floor(((match[1]?.length ?? 0) * 3) / 4)
      if (totalBytes > 16 * 1024 * 1024) {
        context.addIssue({
          code: 'custom',
          path: ['attachments'],
          message: 'The combined attachment size is too large.',
        })
        return
      }
    }
  })
const agentConfigurationSchema = z
  .object({
    preset: id,
    toolMode: z.enum(['native', 'code', 'both']),
    permissionPreset: id,
    planMode: z.boolean(),
    sandboxMode: id.optional(),
    approvalPolicy: id.optional(),
    model: z
      .object({
        providerId: z.string().max(256),
        modelId: z.string().max(256),
        reasoningLevel: z.string().max(128).optional(),
      })
      .strict(),
  })
  .strict()
const questionAnswerSchema = z
  .object({
    id,
    response: z.union([z.string().max(100_000), z.array(id).max(32)]),
  })
  .strict()

const boundedUnknown = z.unknown().superRefine((value, context) => {
  const failure = budgetFailure(value)
  if (failure !== undefined) context.addIssue({ code: 'custom', message: failure })
})

export const webviewRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('app.ready'), ...requestBase }).strict(),
  z.object({ type: z.literal('connection.retry'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('runtime.action'),
      ...requestBase,
      payload: z.object({ action: z.enum(['install', 'select', 'copy-command', 'open-docs']) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('workspace.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('workspace.create'),
      ...requestBase,
      payload: z.object({ name: z.string().min(1).max(256) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.rename'),
      ...requestBase,
      payload: z.object({ workspaceId: id, name: z.string().min(1).max(256) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workspace.remove'),
      ...requestBase,
      payload: z.object({ workspaceId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.list'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id.optional(),
          search: z.string().max(512).optional(),
          archived: z.boolean().optional(),
          cursor: z.string().max(2048).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('session.open'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('session.create'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id.optional(),
          title: z.string().max(512).optional(),
          configuration: agentConfigurationSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.rename'),
      ...requestBase,
      payload: z.object({ sessionId: id, title: z.string().min(1).max(512) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.remove'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('session.fork'),
      ...requestBase,
      payload: z.object({ sessionId: id, atSeq: z.number().int().nonnegative().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.archive'),
      ...requestBase,
      payload: z.object({ sessionId: id, archived: z.boolean() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('session.sendPrompt'), ...requestBase, payload: promptSchema }).strict(),
  z
    .object({
      type: z.literal('session.enqueuePrompt'),
      ...requestBase,
      payload: promptSchema.extend({ mode: z.enum(['queue', 'steer']) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.queue.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.update'),
      ...requestBase,
      payload: z.object({ inputId: id, text: z.string().max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.remove'),
      ...requestBase,
      payload: z.object({ inputId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.queue.steer'),
      ...requestBase,
      payload: z.object({ inputId: id }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('session.cancel'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('session.configure'),
      ...requestBase,
      payload: z.object({ sessionId: id, configuration: agentConfigurationSchema }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('attachment.pick'), ...requestBase }).strict(),
  z.object({ type: z.literal('attachment.open.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('attachment.open.attach'),
      ...requestBase,
      payload: z.object({ candidateId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.read'),
      ...requestBase,
      payload: z.object({ sessionId: id, attachmentId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.list'),
      ...requestBase,
      payload: z.object({ providerId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('models.session.list'),
      ...requestBase,
      payload: z.object({ sessionId: id }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('providers.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('provider.secret.configure'),
      ...requestBase,
      payload: z.object({ providerId: id, field: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('provider.secret.remove'),
      ...requestBase,
      payload: z.object({ providerId: id, field: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.permission.respond'),
      ...requestBase,
      payload: z.object({ interactionId: id, optionId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('interaction.question.respond'),
      ...requestBase,
      payload: z
        .object({
          questionId: id,
          response: z.union([
            z.string().max(100_000),
            z.array(id).max(32),
            z.array(questionAnswerSchema).max(64),
          ]),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('settings.read'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512), value: boundedUnknown }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.replace'),
      ...requestBase,
      payload: z.object({ values: z.record(z.string(), boundedUnknown) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('goal.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('goal.create'),
      ...requestBase,
      payload: z.object({ sessionId: id, title: z.string().min(1).max(1024) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('goal.update'),
      ...requestBase,
      payload: z
        .object({
          goalId: id,
          title: z.string().min(1).max(1024).optional(),
          status: z.enum(['pending', 'in-progress', 'completed', 'blocked']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('goal.clear'), ...requestBase, payload: z.object({ goalId: id }).strict() })
    .strict(),
  z.object({ type: z.literal('job.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({ type: z.literal('job.cancel'), ...requestBase, payload: z.object({ jobId: id }).strict() })
    .strict(),
  z
    .object({ type: z.literal('subagent.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({ type: z.literal('subagent.history'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('subagent.send'),
      ...requestBase,
      payload: z.object({ sessionId: id, message: z.string().min(1).max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('subagent.interrupt'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({ type: z.literal('workflow.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('workflow.start'),
      ...requestBase,
      payload: z.object({ sessionId: id, workflowId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('workflow.cancel'),
      ...requestBase,
      payload: z.object({ workflowId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.list'),
      ...requestBase,
      payload: z.object({ sessionId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.refresh'),
      ...requestBase,
      payload: z.object({ sessionId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('skill.execute'),
      ...requestBase,
      payload: z.object({ sessionId: id, skillId: id, input: z.string().max(1_000_000) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.list'),
      ...requestBase,
      payload: z.object({ sessionId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('command.execute'),
      ...requestBase,
      payload: z.object({ sessionId: id, command: z.string().min(1).max(100_000) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('plugin.list'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('plugin.configure'),
      ...requestBase,
      payload: z.object({ pluginId: id, enabled: z.boolean() }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('preset.list'), ...requestBase }).strict(),
  z
    .object({ type: z.literal('preset.read'), ...requestBase, payload: z.object({ presetId: id }).strict() })
    .strict(),
  z
    .object({
      type: z.literal('preset.copy'),
      ...requestBase,
      payload: z.object({ from: id, presetId: id, name: z.string().max(256).optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset.openDocument'),
      ...requestBase,
      payload: z.object({ presetId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset.remove'),
      ...requestBase,
      payload: z.object({ presetId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('preset.select'),
      ...requestBase,
      payload: z.object({ sessionId: id, presetId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.export'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          format: z.enum(['markdown', 'json', 'zip']),
          includeAttachments: z.boolean(),
          includeReasoning: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('diagnostics.show'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('view.openLink'),
      ...requestBase,
      payload: z.object({ href: z.string().min(1).max(4_096) }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('view.moveRightGuide'), ...requestBase }).strict(),
])

const hostError = z
  .object({
    code: z.enum([
      'DSH_NOT_FOUND',
      'DSH_INCOMPATIBLE',
      'BACKEND_UNREACHABLE',
      'BACKEND_BUSY',
      'NO_RUNNING_INSTANCE',
      'PORT_CONFLICT',
      'INVALID_ENDPOINT',
      'CAPABILITY_UNAVAILABLE',
      'AUTH_REQUIRED',
      'PERMISSION_DENIED',
      'STALE_INTERACTION',
      'PROCESS_FAILED',
      'EXPORT_FAILED',
      'PROTOCOL_ERROR',
      'REQUEST_CANCELLED',
      'INVALID_CONFIGURATION',
      'INTERNAL_ERROR',
    ]),
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
  })
  .strict()

export const hostResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      type: z.literal('response'),
      requestId: id,
      ok: z.literal(true),
      payload: boundedUnknown.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('response'),
      requestId: id,
      ok: z.literal(false),
      error: hostError,
    })
    .strict(),
])

export const hostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    payload: boundedUnknown,
  })
  .strict()

export const hostMessageSchema = z.union([hostResponseSchema, hostEventSchema])

export const webviewEnvelopeSchema = z
  .object({ protocolVersion: wireVersion, message: webviewRequestSchema })
  .strict()

export const hostEnvelopeSchema = z
  .object({ protocolVersion: wireVersion, message: hostMessageSchema })
  .strict()

export function protocolValueWithinBudget(value: unknown): boolean {
  return budgetFailure(value) === undefined
}

function budgetFailure(value: unknown): string | undefined {
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringBytes = 0
  const visit = (entry: unknown, depth: number): string | undefined => {
    nodes += 1
    if (nodes > MAX_PROTOCOL_NODES) return 'The protocol message contains too many values.'
    if (depth > 32) return 'The protocol message is too deeply nested.'
    if (typeof entry === 'string') {
      if (entry.length > 16_000_000) return 'A protocol string exceeds the size limit.'
      stringBytes += entry.length
      return stringBytes > 32_000_000 ? 'The protocol message exceeds the size limit.' : undefined
    }
    if (typeof entry !== 'object' || entry === null) return undefined
    if (seen.has(entry)) return 'The protocol message contains a cyclic value.'
    seen.add(entry)
    if (Array.isArray(entry)) {
      for (const child of entry) {
        const failure = visit(child, depth + 1)
        if (failure !== undefined) return failure
      }
    } else {
      for (const [key, child] of Object.entries(entry)) {
        const keyFailure = visit(key, depth + 1)
        if (keyFailure !== undefined) return keyFailure
        const failure = visit(child, depth + 1)
        if (failure !== undefined) return failure
      }
    }
    return undefined
  }
  return visit(value, 0)
}
