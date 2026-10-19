import { z } from 'zod'

export const editorIntegrationPreferencesSchema = z
  .object({ enabled: z.boolean(), autoSetup: z.boolean(), allowEdits: z.boolean() })
  .strict()
export const editorIntegrationStatusSchema = z
  .object({
    kind: z.literal('editor.companion'),
    preferences: editorIntegrationPreferencesSchema,
    phase: z.enum(['off', 'waiting', 'connecting', 'ready', 'limited', 'setup', 'needs-restart', 'error']),
    reason: z
      .enum([
        'disconnected',
        'workspace',
        'untrusted',
        'session',
        'unsupported',
        'missing',
        'busy',
        'connection',
        'setup-failed',
        'restart',
      ])
      .optional(),
    version: z.string().max(128).optional(),
    capabilities: z.array(z.enum(['content', 'diagnostics', 'language', 'navigation', 'edit'])).max(5),
    canInstall: z.boolean(),
    canRestart: z.boolean(),
    canUndo: z.boolean(),
  })
  .strict()
