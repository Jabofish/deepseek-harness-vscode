import { z } from 'zod'

const id = z.string().min(1).max(256)
const wireVersion = z.literal(1)
const requestBase = { requestId: id }
// Historical DSH transcripts contain many structured stream events. The
// adapter compacts visible deltas before they reach this boundary, while this
// larger node budget still permits genuinely long sessions without turning a
// valid response into a protocol error. String-size limits remain unchanged.
const MAX_PROTOCOL_NODES = 100_000
const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil((20 * 1024 * 1024) / 3) * 4
const MAX_PROMPT_ATTACHMENTS = 20
const MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024
const session = { sessionId: id }
const attachmentUri = z.string().regex(/^dsh-attachment:[A-Za-z0-9-]{16,128}$/)
const attachmentSchema = z
  .object({
    // The Extension Host owns the bytes. The Webview only sends back this
    // short-lived opaque handle, never a path or a data URI.
    uri: attachmentUri,
    name: z.string().min(1).max(512),
    mimeType: z.string().max(256).optional(),
  })
  .strict()
const promptSchema = z
  .object({
    sessionId: id,
    text: z.string().max(1_000_000),
    attachments: z.array(attachmentSchema).max(MAX_PROMPT_ATTACHMENTS),
  })
  .strict()
  .superRefine((value, context) => {
    let totalBytes = 0
    for (const attachment of value.attachments) {
      const match = attachment.uri.match(/^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/i)
      if (match === null) continue
      totalBytes += Math.floor(((match[1]?.length ?? 0) * 3) / 4)
      if (totalBytes > MAX_PROMPT_ATTACHMENT_TOTAL_BYTES) {
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
    // Upstream `custom`: free-text answer that may accompany a selection.
    custom: z.string().max(100_000).optional(),
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
      type: z.literal('connection.configure'),
      ...requestBase,
      payload: z
        .object({
          mode: z.enum(['auto', 'custom']),
          endpoint: z.string().max(512).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('runtime.action'),
      ...requestBase,
      payload: z.object({ action: z.enum(['install', 'select', 'copy-command', 'open-docs']) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('runtime.update.check'),
      ...requestBase,
      payload: z.object({ force: z.boolean().optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('runtime.update.install'),
      ...requestBase,
      payload: z.object({ version: z.string().min(1).max(128) }).strict(),
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
      type: z.literal('workspace.move'),
      ...requestBase,
      payload: z.object({ workspaceId: id, beforeWorkspaceId: id.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.move'),
      ...requestBase,
      payload: z.object({ workspaceId: id, sessionId: id, beforeSessionId: id.optional() }).strict(),
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
      type: z.literal('session.history'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          beforeSeq: z.number().int().nonnegative().optional(),
          maxMessages: z.number().int().positive().max(200).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session.create'),
      ...requestBase,
      payload: z
        .object({
          workspaceId: id.optional(),
          sessionId: id.optional(),
          reuseWorkspaceBlank: z.literal(true).optional(),
          title: z.string().max(512).optional(),
          configuration: agentConfigurationSchema,
        })
        .strict()
        .refine(
          (payload) =>
            payload.reuseWorkspaceBlank !== true ||
            (payload.workspaceId !== undefined && payload.sessionId !== undefined),
          { message: 'Reusing a workspace blank session requires workspaceId and sessionId.' },
        ),
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
  z
    .object({
      type: z.literal('session.sendPrompt'),
      ...requestBase,
      payload: promptSchema.extend({ mode: z.enum(['queue', 'steer']).default('queue') }),
    })
    .strict(),
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
  z
    .object({
      // Paste/drop bytes originate in the Webview; the Extension Host still
      // owns validation and storage and returns the same opaque handle.
      type: z.literal('attachment.ingest'),
      ...requestBase,
      payload: z
        .object({
          name: z.string().min(1).max(512),
          mimeType: z.string().max(256).optional(),
          // rc.2 permits 20 MiB images; the Extension Host still performs
          // MIME-aware validation and keeps non-image files at 8 MiB.
          dataBase64: z.string().min(1).max(MAX_ATTACHMENT_BASE64_CHARS),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.preview'),
      ...requestBase,
      payload: z.object({ uri: attachmentUri }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('attachment.release'),
      ...requestBase,
      payload: z.object({ uris: z.array(attachmentUri).min(1).max(MAX_PROMPT_ATTACHMENTS) }).strict(),
    })
    .strict(),
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
      type: z.literal('reference.list'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          query: z.string().max(4_096),
          quoted: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('feedback.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('feedback.toggle'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          messageId: id,
          rating: z.enum(['positive', 'negative']),
          note: z.string().max(16_384).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feedback.note'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          messageId: id,
          rating: z.enum(['positive', 'negative']),
          note: z.string().max(16_384).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('feedback.remove'),
      ...requestBase,
      payload: z.object({ sessionId: id, messageId: id }).strict(),
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
  z
    .object({
      type: z.literal('models.discover'),
      ...requestBase,
      payload: z
        .object({
          settingsNamespace: id,
          providerId: id.optional(),
          baseUrl: z.string().max(2048).optional(),
          api: z.string().max(128).optional(),
        })
        .strict(),
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
  z
    .object({
      type: z.literal('interaction.question.cancel'),
      ...requestBase,
      payload: z.object({ questionId: id }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('settings.read'), ...requestBase }).strict(),
  z.object({ type: z.literal('settings.openDocument'), ...requestBase }).strict(),
  // Extension-local facts (connection/runtime defaults). The DSH host settings
  // snapshot travels on settings.read; the two must not be conflated.
  z.object({ type: z.literal('extensionSettings.read'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512), value: boundedUnknown }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.unset'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512) }).strict(),
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
      payload: z
        .object({
          sessionId: id,
          command: z.string().min(1).max(100_000),
          attachments: z.array(attachmentSchema).max(MAX_PROMPT_ATTACHMENTS).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('plugin.inventory'), ...requestBase }).strict(),
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
  z
    .object({
      type: z.literal('view.showInFolder'),
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
