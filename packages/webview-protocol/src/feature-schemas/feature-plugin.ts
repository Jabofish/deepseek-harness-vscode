import { z } from 'zod'
import { safeLabel } from './feature-shared.js'

export const pluginBundleTextSchema = z.union([
  z.string().max(4_096),
  z
    .object({ en: z.string().max(4_096) })
    .catchall(z.string().max(4_096))
    .superRefine((value, context) => {
      const entries = Object.entries(value)
      if (entries.length > 16 || !entries.every(([locale]) => /^[A-Za-z0-9-]{1,32}$/u.test(locale)))
        context.addIssue({ code: 'custom', message: 'Localized bundle text has invalid locale keys.' })
    }),
])
export const pluginMetadataSchema = z
  .object({
    title: pluginBundleTextSchema.optional(),
    description: pluginBundleTextSchema.optional(),
  })
  .strict()
export const pluginRegistryUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      )
    } catch {
      return false
    }
  }, 'Registry URLs cannot contain credentials or query data.')
export const pluginRegistrySchema = z.union([z.literal(null), pluginRegistryUrlSchema])
export const pluginBundleErrorCodeSchema = z.enum([
  'management-required',
  'unaddressable',
  'unknown-plugin',
  'invalid-spec',
  'ambiguous-install',
  'not-bundle',
  'not-removable',
  'stop-profile',
  'bundle-in-use',
  'stale-approval',
  'incompatible-version',
  'operation-error',
])
export const managedPluginEntrySchema = z
  .object({
    entryId: safeLabel,
    moduleName: safeLabel,
    meta: pluginMetadataSchema.optional(),
    enabled: z.boolean(),
    fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable(),
    readOnlyReason: z.enum(['management-required', 'unaddressable']).optional(),
  })
  .strict()
export const pluginBundleRowSchema = z
  .object({
    rowId: safeLabel,
    moduleName: safeLabel,
    meta: pluginMetadataSchema.optional(),
    entryId: safeLabel.optional(),
  })
  .strict()
export const managedPluginBundleSchema = z
  .object({
    name: safeLabel,
    version: z.string().max(128).optional(),
    title: pluginBundleTextSchema.optional(),
    description: pluginBundleTextSchema.optional(),
    enabled: z.boolean(),
    installed: z.boolean(),
    optional: z.boolean(),
    removable: z.boolean(),
    readOnlyReason: z.enum(['management-required', 'unaddressable']).optional(),
    errorCode: pluginBundleErrorCodeSchema.optional(),
    rows: z.array(pluginBundleRowSchema).max(2_000),
    overrides: z.array(safeLabel).max(2_000),
  })
  .strict()
export const pluginBundleChangeResultSchema = z
  .object({
    name: safeLabel,
    changed: z.boolean(),
    application: z.enum(['applied', 'restart-required', 'overridden', 'failed', 'cancelled']),
    enabled: z.boolean().optional(),
    stage: z.enum(['install', 'enable', 'remove']).optional(),
    errorCode: pluginBundleErrorCodeSchema.optional(),
    failureKind: z
      .enum([
        'pnpm-missing',
        'timeout',
        'not-found',
        'no-matching-version',
        'network',
        'disk-full',
        'permission',
        'build-blocked',
        'integrity',
        'unknown',
      ])
      .optional(),
    failedAt: z.enum(['registry', 'spec-host']).optional(),
    bundle: safeLabel.optional(),
    pendingBuilds: z.array(safeLabel).max(256).optional(),
  })
  .strict()
export const pluginInspectionSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('accepted'),
      kind: z.enum(['registry', 'path', 'git', 'tarball']),
      name: safeLabel.optional(),
      version: z.string().max(128).optional(),
      description: z.string().max(4_096).optional(),
      bundle: z.boolean().nullable(),
      registry: pluginRegistrySchema,
      host: z.string().max(255).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('refused'),
      problem: z.enum([
        'invalid-spec',
        'already-installed',
        'not-found',
        'not-a-package',
        'not-a-bundle',
        'network',
        'unknown',
      ]),
      registries: z.array(pluginRegistrySchema).max(64).optional(),
    })
    .strict(),
])
export const pluginRegistriesSchema = z
  .object({
    registry: pluginRegistrySchema,
    fallbackRegistries: z.array(pluginRegistryUrlSchema).max(64),
    resolved: pluginRegistrySchema,
  })
  .strict()
