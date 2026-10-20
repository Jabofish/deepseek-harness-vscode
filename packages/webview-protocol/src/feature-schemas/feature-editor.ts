import { z } from 'zod'
import { pluginBundleErrorCodeSchema, pluginBundleChangeResultSchema } from './feature-plugin.js'

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
    installation: z
      .enum([
        'preparing-dependencies',
        'dependencies-failed',
        'installing',
        'cancelling',
        'unknown',
        'cancelled',
        'failed',
        'installed',
      ])
      .optional(),
    canCancelInstall: z.boolean().optional(),
    installationErrorCode: pluginBundleErrorCodeSchema.optional(),
    installationFailureKind: pluginBundleChangeResultSchema.shape.failureKind,
    installed: z.boolean().optional(),
    packageManager: z.enum(['ready', 'missing', 'broken']).optional(),
  })
  .strict()
