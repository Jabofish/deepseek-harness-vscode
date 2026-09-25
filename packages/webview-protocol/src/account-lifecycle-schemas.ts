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

const accountDecimal = z
  .string()
  .min(1)
  .max(128)
  .regex(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu)
const accountCurrency = z.enum(['CNY', 'USD'])
const accountWallet = z.object({ currency: accountCurrency, balance: accountDecimal }).strict()
const accountReadFailure = z.union([
  z.object({ status: z.literal('unavailable') }).strict(),
  z.object({ status: z.literal('failed') }).strict(),
])

/** Safe RC2 account panel DTO; account IDs, avatar URLs, and credentials are excluded. */
export const accountProfileDetailsSnapshotSchema = z
  .object({
    profile: z.union([
      z
        .object({
          status: z.literal('ready'),
          value: z
            .object({ name: z.string().max(512).nullable(), contact: z.string().max(512).nullable() })
            .strict(),
        })
        .strict(),
      accountReadFailure,
    ]),
    balance: z.union([
      z
        .object({
          status: z.literal('ready'),
          value: z
            .object({
              wallets: z.array(accountWallet).max(32),
              bonusWallets: z.array(accountWallet).max(32),
            })
            .strict(),
        })
        .strict(),
      accountReadFailure,
    ]),
    bonus: z.union([
      z
        .object({
          status: z.literal('ready'),
          value: z
            .object({
              orderId: z.string().uuid(),
              message: z.string().max(4_096),
              amount: accountDecimal,
              currency: accountCurrency,
              expiresAt: z.string().max(128),
            })
            .strict()
            .nullable(),
        })
        .strict(),
      accountReadFailure,
    ]),
  })
  .strict()

export type AccountLifecycleSnapshotDto = z.infer<typeof accountLifecycleSnapshotSchema>
export type AccountSignOutImpactDto = z.infer<typeof accountSignOutImpactSchema>
export type AccountLifecycleErrorCodeDto = z.infer<typeof accountLifecycleErrorCodeSchema>
export type AccountProfileDetailsSnapshotDto = z.infer<typeof accountProfileDetailsSnapshotSchema>
