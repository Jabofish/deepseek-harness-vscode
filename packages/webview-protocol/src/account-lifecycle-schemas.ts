import { z } from 'zod'

/** Wire-safe account view. Strict keys prevent auth URLs or credentials from crossing the boundary. */
export const accountLifecycleSnapshotSchema = z
  .object({
    status: z.enum(['signed-out', 'credential-stored']),
    attempt: z
      .object({
        id: z.string().uuid(),
        phase: z.enum([
          'initializing',
          'waiting-browser',
          'exchanging',
          'committing',
          'succeeded',
          'cancelled',
          'expired',
          'failed',
        ]),
        expiresAt: z.number().int().nonnegative().optional(),
        errorCode: z.enum(['network', 'protocol', 'expired', 'storage']).optional(),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const accountSignOutImpactSchema = z.enum(['none', 'running', 'unknown'])
export const accountLifecycleErrorCodeSchema = z.enum([
  'state-stream-failed',
  'expiry-stream-failed',
  'browser-open-failed',
])

export type AccountLifecycleSnapshotDto = z.infer<typeof accountLifecycleSnapshotSchema>
export type AccountSignOutImpactDto = z.infer<typeof accountSignOutImpactSchema>
export type AccountLifecycleErrorCodeDto = z.infer<typeof accountLifecycleErrorCodeSchema>
