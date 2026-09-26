import { z } from 'zod'
import { protocolAppErrorCodeSchema } from './feature-schemas.js'

const id = z.string().min(1).max(256)
const wireVersion = z.literal(1)
const requestBase = { requestId: id }
// Historical DSH transcripts contain many structured stream events. The
// adapter compacts visible deltas before they reach this boundary, while this
// larger node budget still permits genuinely long sessions without turning a
// valid response into a protocol error.
const MAX_PROTOCOL_NODES = 100_000
const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil((20 * 1024 * 1024) / 3) * 4
// One admitted attachment must survive the budget check in both directions:
// `attachment.ingest` carries the Base64 payload itself, and `attachment.preview`
// returns it inside a data URI. A per-string cap below this envelope rejected
// supported 12-20 MiB images before the schema was ever consulted.
const MAX_PROTOCOL_STRING_CHARS = MAX_ATTACHMENT_BASE64_CHARS + 1_024
// Two maximum-size strings: the attachment envelope plus the message around it,
// which is what a prompt body and one attachment can legitimately amount to.
const MAX_PROTOCOL_STRING_BYTES = MAX_PROTOCOL_STRING_CHARS * 2
const MAX_PROMPT_ATTACHMENTS = 20
const MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024
// The Host reduces every RPC failure to one short sentence. The bound is
// exported because the extension builds that sentence from host-supplied text
// (an RPC error code, a method name) and must keep it inside the wire budget
// instead of emitting a response the Webview would reject wholesale.
export const MAX_HOST_ERROR_MESSAGE_CHARS = 1_024
const session = { sessionId: id }
const attachmentUri = z.string().regex(/^dsh-attachment:[A-Za-z0-9-]{16,128}$/)
const contextRef = z.string().regex(/^dsh-context:[A-Za-z0-9-]{16,128}$/)
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
    // Context refs are Host-owned opaque handles. Their bytes are resolved
    // and frozen by the Extension Host before DSH receives the prompt.
    contextRefs: z.array(contextRef).max(8).optional(),
    // When context refs are attached, the Webview reports the one workspace
    // folder represented by the chips. The Host still validates this against
    // the session and the opaque refs; it is not an authority by itself.
    contextWorkspaceFolderId: id.optional(),
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
const diagnosticsStateSchema = z.enum([
  'idle',
  'locating-runtime',
  'discovering',
  'connecting',
  'connected',
  'starting',
  'runtime-missing',
  'failed',
  'port-conflict',
  'stopping',
])

/** Host-owned, redacted, and bounded data for the in-app diagnostics surface. */
export const diagnosticsSnapshotSchema = z
  .object({
    extensionVersion: z.string().min(1).max(128),
    dshVersion: z.string().min(1).max(128).optional(),
    state: diagnosticsStateSchema,
    endpointKind: z.enum(['configured', 'external', 'managed']).optional(),
    canReconnect: z.boolean(),
    recentEvents: z.array(z.string().max(8_193)).max(32),
  })
  .strict()
const agentConfigurationSchema = z
  .object({
    preset: id,
    toolMode: z.enum(['native', 'ptc', 'code', 'both']),
    permissionPreset: id,
    planMode: z.boolean(),
    planModeKnown: z.boolean().optional(),
    permissionPresetKnown: z.boolean().optional(),
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
const settingsRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const settingsOperationPath = z.array(z.string().trim().min(1).max(256)).min(1).max(64)
const settingsOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: settingsOperationPath, value: boundedUnknown }).strict(),
  z.object({ op: z.literal('unset'), path: settingsOperationPath }).strict(),
])
const sensitiveCustomProviderModelKeys = new Set(
  [
    'apiKey',
    'accessToken',
    'authorization',
    'password',
    'secret',
    'secretKey',
    'privateKey',
    'token',
    'credential',
    'credentials',
    'auth',
    'headers',
    'cookies',
  ].map(normalizeCustomProviderModelKey),
)
const customProviderModelSchema = z
  .record(z.string().min(1).max(128), boundedUnknown)
  .superRefine((value, context) => {
    if (containsSensitiveCustomProviderModelKey(value))
      context.addIssue({ code: 'custom', message: 'Provider model metadata must not contain credentials.' })
    for (const [field, allowEmpty] of [
      ['input', true],
      ['inputModalities', false],
    ] as const) {
      const modalities = value[field]
      if (
        modalities !== undefined &&
        (!Array.isArray(modalities) ||
          (!allowEmpty && modalities.length === 0) ||
          !modalities.every((modality) => modality === 'text' || modality === 'image'))
      )
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `Provider model ${field} is invalid.`,
        })
    }
  })

function normalizeCustomProviderModelKey(key: string): string {
  return key.replace(/[-_]/gu, '').toLowerCase()
}

function containsSensitiveCustomProviderModelKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== 'object' || value === null) return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveCustomProviderModelKey(entry, seen))
  return Object.entries(value).some(
    ([key, child]) =>
      sensitiveCustomProviderModelKeys.has(normalizeCustomProviderModelKey(key)) ||
      containsSensitiveCustomProviderModelKey(child, seen),
  )
}

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
  z.object({ type: z.literal('workspace.addFolder'), ...requestBase }).strict(),
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
          pagePurpose: z.enum(['transcript', 'gap-recovery']).optional(),
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
          category: z
            .enum([
              'task-result',
              'instruction-following',
              'product-interaction',
              'service-stability',
              'resource-cost',
              'security-privacy-permission',
              'other',
            ])
            .optional(),
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
          category: z
            .enum([
              'task-result',
              'instruction-following',
              'product-interaction',
              'service-stability',
              'resource-cost',
              'security-privacy-permission',
              'other',
            ])
            .optional(),
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
  z
    .object({
      type: z.literal('models.discover.custom'),
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
      type: z.literal('provider.custom.create'),
      ...requestBase,
      payload: z
        .object({
          settingsNamespace: id,
          collectionPath: z.array(id).min(1).max(32),
          providerId: id,
          displayName: z.string().max(512).optional(),
          api: z.string().min(1).max(128),
          baseUrl: z.string().min(1).max(2048),
          models: z.array(customProviderModelSchema).min(1).max(1024),
          expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.credential.configure'),
      ...requestBase,
      payload: z.object({ ref: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('plugin.credential.remove'),
      ...requestBase,
      payload: z.object({ ref: id }).strict(),
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
  z.object({ type: z.literal('settings.openKeyboardShortcuts'), ...requestBase }).strict(),
  // Extension-local facts (connection/runtime defaults). The DSH host settings
  // snapshot travels on settings.read; the two must not be conflated.
  z.object({ type: z.literal('extensionSettings.read'), ...requestBase }).strict(),
  z
    .object({
      type: z.literal('settings.update'),
      ...requestBase,
      payload: z
        .object({
          path: z.string().min(1).max(512),
          value: boundedUnknown,
          expectedRevision: settingsRevision,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.unset'),
      ...requestBase,
      payload: z.object({ path: z.string().min(1).max(512), expectedRevision: settingsRevision }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('settings.mutate'),
      ...requestBase,
      payload: z
        .object({
          namespace: z.string().trim().min(1).max(256),
          expectedRevision: settingsRevision,
          operations: z.array(settingsOperationSchema).min(1).max(128),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('goal.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('goal.update'),
      ...requestBase,
      payload: z
        .object({
          goalId: id,
          title: z.string().min(1).max(1024).optional(),
          status: z.enum(['pending', 'in-progress', 'completed', 'blocked']).optional(),
          maxGoalRounds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('goal.clear'), ...requestBase, payload: z.object({ goalId: id }).strict() })
    .strict(),
  z.object({ type: z.literal('job.list'), ...requestBase, payload: z.object(session).strict() }).strict(),
  z
    .object({
      type: z.literal('job.kill'),
      ...requestBase,
      payload: z.object({ sessionId: id, jobId: id }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('job.follow.start'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          jobId: id,
          followId: id,
          from: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('job.follow.stop'),
      ...requestBase,
      payload: z.object({ sessionId: id, jobId: id, followId: id }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal('subagent.list'), ...requestBase, payload: z.object(session).strict() })
    .strict(),
  z
    .object({
      type: z.literal('subagent.history'),
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
      type: z.literal('subagent.send'),
      ...requestBase,
      payload: z
        .object({
          sessionId: id,
          message: z.string().min(1).max(1_000_000),
          // Kept optional at the protocol boundary for older Webviews; the
          // parsed output always supplies the DSH delivery default.
          mode: z.enum(['queue', 'steer']).optional().default('queue'),
          attachments: z.array(attachmentSchema).max(MAX_PROMPT_ATTACHMENTS).optional(),
        })
        .strict(),
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
      type: z.literal('skill.openDocument'),
      ...requestBase,
      payload: z.object({ ...session, skillId: id }).strict(),
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
  z.object({ type: z.literal('diagnostics.snapshot'), ...requestBase }).strict(),
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
])

const hostError = z
  .object({
    code: protocolAppErrorCodeSchema,
    message: z.string().min(1).max(MAX_HOST_ERROR_MESSAGE_CHARS),
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

const jobFollowSafeOffsetSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine((value) => !Object.is(value, -0))

const jobFollowOutputSchema = z
  .object({ total: jobFollowSafeOffsetSchema, earliest: jobFollowSafeOffsetSchema })
  .strict()
  .superRefine((value, context) => {
    if (value.earliest > value.total)
      context.addIssue({ code: 'custom', path: ['earliest'], message: 'earliest must not exceed total.' })
  })

const jobFollowJobViewSchema = z
  .object({
    id,
    kind: z.string().min(1),
    label: z.string().min(1),
    status: z.enum(['running', 'stopping', 'completed', 'failed', 'killed']),
    detail: z.string().optional(),
    progress: z.string().optional(),
    startedAt: jobFollowSafeOffsetSchema,
    finishedAt: jobFollowSafeOffsetSchema.optional(),
    output: jobFollowOutputSchema.optional(),
  })
  .strict()
  .transform((value) => ({
    id: value.id,
    kind: value.kind,
    label: value.label,
    status: value.status,
    startedAt: value.startedAt,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    ...(value.progress === undefined ? {} : { progress: value.progress }),
    ...(value.finishedAt === undefined ? {} : { finishedAt: value.finishedAt }),
    ...(value.output === undefined ? {} : { output: value.output }),
  }))

const jobFollowChunkSchema = z
  .object({
    at: jobFollowSafeOffsetSchema,
    text: z.string(),
    channel: z.enum(['stdout', 'stderr', 'log']).optional(),
    gapBefore: z.literal(true).optional(),
  })
  .strict()
  .transform((value) => ({
    at: value.at,
    text: value.text,
    ...(value.channel === undefined ? {} : { channel: value.channel }),
    ...(value.gapBefore === undefined ? {} : { gapBefore: value.gapBefore }),
  }))

export const jobFollowFrameSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('opened'), job: jobFollowJobViewSchema, from: jobFollowSafeOffsetSchema })
    .strict(),
  z
    .object({
      type: z.literal('output'),
      chunks: z.array(jobFollowChunkSchema).max(100_000),
      next: jobFollowSafeOffsetSchema,
      lossy: z.literal(true).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const encoder = new TextEncoder()
      let previousEnd: number | undefined
      let lastByteEnd: number | undefined
      if (value.chunks.length === 0 && value.lossy !== true)
        context.addIssue({
          code: 'custom',
          path: ['chunks'],
          message: 'An empty output frame must mark a lossy cursor advance.',
        })
      for (const [index, chunk] of value.chunks.entries()) {
        const end = chunk.at + encoder.encode(chunk.text).byteLength
        if (!Number.isSafeInteger(end) || end > value.next)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'Chunk end must not exceed next.',
          })
        if (
          chunk.text.length === 0 &&
          (chunk.gapBefore !== true || value.lossy !== true || chunk.at !== value.next)
        )
          context.addIssue({
            code: 'custom',
            path: ['chunks', index, 'text'],
            message: 'An empty chunk must mark a lossy tail at next.',
          })
        if (previousEnd !== undefined && chunk.at < previousEnd)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index, 'at'],
            message: 'Chunks must not overlap.',
          })
        if (previousEnd !== undefined && chunk.at > previousEnd && chunk.gapBefore !== true)
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'An internal gap must be marked on its chunk.',
          })
        previousEnd = end
        if (chunk.text.length > 0) lastByteEnd = end
      }
      if (lastByteEnd !== undefined && lastByteEnd !== value.next)
        context.addIssue({
          code: 'custom',
          path: ['next'],
          message: 'Next must equal the end of the last byte-bearing chunk.',
        })
    })
    .transform((value) => ({
      type: value.type,
      chunks: value.chunks,
      next: value.next,
      ...(value.lossy === undefined ? {} : { lossy: value.lossy }),
    })),
  z.object({ type: z.literal('status'), job: jobFollowJobViewSchema }).strict(),
])

export const jobFollowUpdatedPayloadSchema = z
  .object({ sessionId: id, jobId: id, followId: id, frame: jobFollowFrameSchema })
  .strict()
  .superRefine((value, context) => {
    const failure = budgetFailure(value)
    if (failure !== undefined) context.addIssue({ code: 'custom', message: failure })
  })

export const jobFollowFailedPayloadSchema = z
  .object({
    sessionId: id,
    jobId: id,
    followId: id,
    reason: z.literal('stream-failed'),
  })
  .strict()

/**
 * Legacy compatibility envelope. New staged feature events must use the
 * closed `featureHostEventSchema`; generic backend events remain open, while
 * Job follow has exact schemas because its byte cursor controls resumed reads.
 */
const genericHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (name) => name !== 'job.follow.updated' && name !== 'job.follow.failed' && name !== 'queue.updated',
      ),
    sequence: z.number().int().nonnegative(),
    payload: boundedUnknown,
  })
  .strict()

const queueUpdatedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('queue.updated'),
    sequence: z.number().int().nonnegative(),
    // Keep legacy queue payloads open; validate the new optional projection
    // watermark without dropping older adapter fields.
    payload: boundedUnknown.superRefine((value, context) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return
      const payload = value as Record<string, unknown>
      if (!Object.hasOwn(payload, 'asOfSequence')) return
      const cut = payload.asOfSequence
      if (typeof cut !== 'number' || !Number.isSafeInteger(cut) || cut < 0 || Object.is(cut, -0))
        context.addIssue({
          code: 'custom',
          message: 'Queue projection sequence must be a safe non-negative integer.',
        })
    }),
  })
  .strict()

const jobFollowUpdatedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('job.follow.updated'),
    sequence: jobFollowSafeOffsetSchema,
    payload: jobFollowUpdatedPayloadSchema,
  })
  .strict()

const jobFollowFailedHostEventSchema = z
  .object({
    type: z.literal('event'),
    name: z.literal('job.follow.failed'),
    sequence: jobFollowSafeOffsetSchema,
    payload: jobFollowFailedPayloadSchema,
  })
  .strict()

export const hostEventSchema = z.union([
  queueUpdatedHostEventSchema,
  jobFollowUpdatedHostEventSchema,
  jobFollowFailedHostEventSchema,
  genericHostEventSchema,
])

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
      if (entry.length > MAX_PROTOCOL_STRING_CHARS) return 'A protocol string exceeds the size limit.'
      stringBytes += entry.length
      return stringBytes > MAX_PROTOCOL_STRING_BYTES
        ? 'The protocol message exceeds the size limit.'
        : undefined
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
