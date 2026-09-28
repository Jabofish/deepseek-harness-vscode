import { z } from 'zod'
import { budgetFailure } from './protocol-budget.js'
export const id = z.string().min(1).max(256)
export const wireVersion = z.literal(1)
export const requestBase = { requestId: id }

export const MAX_PROMPT_ATTACHMENTS = 20
export const MAX_PROMPT_ATTACHMENT_TOTAL_BYTES = 200 * 1024 * 1024
// The Host reduces every RPC failure to one short sentence. The bound is
// exported because the extension builds that sentence from host-supplied text
// (an RPC error code, a method name) and must keep it inside the wire budget
// instead of emitting a response the Webview would reject wholesale.
export const MAX_HOST_ERROR_MESSAGE_CHARS = 1_024
export const session = { sessionId: id }
export const attachmentUri = z.string().regex(/^dsh-attachment:[A-Za-z0-9-]{16,128}$/)
export const contextRef = z.string().regex(/^dsh-context:[A-Za-z0-9-]{16,128}$/)
export const attachmentSchema = z
  .object({
    // The Extension Host owns the bytes. The Webview only sends back this
    // short-lived opaque handle, never a path or a data URI.
    uri: attachmentUri,
    name: z.string().min(1).max(512),
    mimeType: z.string().max(256).optional(),
  })
  .strict()
export const promptSchema = z
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
export const diagnosticsStateSchema = z.enum([
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
export const agentConfigurationSchema = z
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
export const questionAnswerSchema = z
  .object({
    id,
    response: z.union([z.string().max(100_000), z.array(id).max(32)]),
    // Upstream `custom`: free-text answer that may accompany a selection.
    custom: z.string().max(100_000).optional(),
  })
  .strict()

export const boundedUnknown = z.unknown().superRefine((value, context) => {
  const failure = budgetFailure(value)
  if (failure !== undefined) context.addIssue({ code: 'custom', message: failure })
})
export const settingsRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const settingsOperationPath = z.array(z.string().trim().min(1).max(256)).min(1).max(64)
export const settingsOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: settingsOperationPath, value: boundedUnknown }).strict(),
  z.object({ op: z.literal('unset'), path: settingsOperationPath }).strict(),
])
export const sensitiveCustomProviderModelKeys = new Set(
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
export const customProviderModelSchema = z
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

export function normalizeCustomProviderModelKey(key: string): string {
  return key.replace(/[-_]/gu, '').toLowerCase()
}

export function containsSensitiveCustomProviderModelKey(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
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
