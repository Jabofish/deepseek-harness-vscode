import { z } from 'zod'
import { CONNECTION_LOG_PHASES, CONNECTION_LOG_STATUSES } from '@dsh-vscode/domain'
import type { ConnectionLogEntry } from '@dsh-vscode/domain'

export const connectionLogEntrySchema = z
  .object({
    id: z.number().int().nonnegative(),
    time: z.string().datetime(),
    elapsedMs: z.number().finite().nonnegative(),
    phase: z.enum(CONNECTION_LOG_PHASES),
    status: z.enum(CONNECTION_LOG_STATUSES),
    attempt: z.number().int().nonnegative().optional(),
    count: z.number().int().nonnegative().optional(),
    hostVersion: z
      .string()
      .max(128)
      .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u)
      .optional(),
    candidateSource: z.enum(['configured', 'known', 'default-port', 'process-scan', 'companion']).optional(),
    ownership: z.enum(['external', 'managed']).optional(),
    mode: z.enum(['auto', 'custom', 'attach-only', 'new-isolated']).optional(),
    code: z
      .enum([
        'DSH_NOT_FOUND',
        'DSH_INCOMPATIBLE',
        'BACKEND_UNREACHABLE',
        'BACKEND_BUSY',
        'NO_RUNNING_INSTANCE',
        'PORT_CONFLICT',
        'INVALID_ENDPOINT',
        'AUTH_REQUIRED',
        'PERMISSION_DENIED',
        'PROCESS_FAILED',
        'PROTOCOL_ERROR',
        'REQUEST_CANCELLED',
        'INVALID_CONFIGURATION',
        'INTERNAL_ERROR',
      ])
      .optional(),
  })
  .strict()
  .transform((value): ConnectionLogEntry => ({
    id: value.id,
    time: value.time,
    elapsedMs: value.elapsedMs,
    phase: value.phase,
    status: value.status,
    ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
    ...(value.count === undefined ? {} : { count: value.count }),
    ...(value.hostVersion === undefined ? {} : { hostVersion: value.hostVersion }),
    ...(value.candidateSource === undefined ? {} : { candidateSource: value.candidateSource }),
    ...(value.ownership === undefined ? {} : { ownership: value.ownership }),
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.code === undefined ? {} : { code: value.code }),
  }))

export const connectionOutputSchema = z.array(connectionLogEntrySchema).max(64)
