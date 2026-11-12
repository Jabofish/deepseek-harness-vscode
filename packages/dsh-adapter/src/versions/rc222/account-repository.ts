import {
  AppError,
  type AccountBonusBatch,
  type AccountClientMetadata,
  type AccountLifecycleSnapshot,
  type AccountNotification,
  type AccountNotificationBatch,
  type AccountNotificationEvent,
} from '@dsh-vscode/domain'
import { z } from 'zod'
import { Alpha215AccountLifecycleRepository } from '../alpha215/account-repository.js'
import type { AccountRemoteTransport } from '../rc172/account-repository.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/\p{Cc}/u.test(value))
const timestamp = z
  .string()
  .max(128)
  .refine((value) => Number.isFinite(Date.parse(value)))
const notificationSchema = z.object({
  id: identifier,
  createdAt: timestamp,
  displayUntil: timestamp.nullable(),
  title: z.string().max(4_096),
  body: z.string().max(16_384),
  actions: z
    .array(
      z
        .object({
          label: z.string().min(1).max(512),
          style: z.enum(['primary', 'secondary']),
          target: z.union([
            z.object({ type: z.literal('app_route'), name: z.literal('account') }).strict(),
            z.object({ type: z.literal('dismiss') }).strict(),
          ]),
        })
        .strict(),
    )
    .max(16),
  // Arbitrary business data is intentionally never copied into the Domain.
})
const batchSchema = z
  .object({
    nextPollAfterSeconds: z.number().positive().max(2_147_483.647),
    notifications: z.array(notificationSchema).max(128),
  })
  .refine(({ notifications }) => new Set(notifications.map(({ id }) => id)).size === notifications.length)

/** The rc.2 service retains namespace account, but watch and notifications changed. */
export class Rc222AccountLifecycleRepository extends Alpha215AccountLifecycleRepository {
  public readonly notifications = {
    getNotifications: (client: AccountClientMetadata, signal?: AbortSignal) =>
      this.getNotifications(client, signal),
    reportNotificationEvent: (
      id: string,
      event: AccountNotificationEvent,
      client: AccountClientMetadata,
      signal?: AbortSignal,
    ) => this.reportNotificationEvent(id, event, client, signal),
  }
  private readonly revision: () => number
  public constructor(private readonly remote: AccountRemoteTransport) {
    let revision = 0
    super({
      remoteRequest: (endpoint, args, signal) => remote.remoteRequest(endpoint, args, signal),
      openRemoteStream: async function* (endpoint, args, signal) {
        for await (const value of remote.openRemoteStream(endpoint, args, signal)) {
          if (signal?.aborted) return
          if (endpoint !== 'account/watch') {
            yield value
            continue
          }
          const update = recordOrUndefined(value)
          if (
            !update ||
            (update.type !== 'snapshot' && update.type !== 'credentials-changed') ||
            !Object.hasOwn(update, 'state')
          )
            throw malformed()
          if (update.type === 'credentials-changed') revision += 1
          yield update.state
        }
      },
    })
    this.revision = () => revision
  }

  public override async *watch(signal: AbortSignal): AsyncIterable<AccountLifecycleSnapshot> {
    for await (const snapshot of super.watch(signal))
      yield { ...snapshot, credentialRevision: this.revision() }
  }

  protected override mapSnapshot(snapshot: AccountLifecycleSnapshot): AccountLifecycleSnapshot {
    return { ...snapshot, credentialRevision: this.revision() }
  }

  /** Bonus-order RPCs were removed; rc.2 notifications use their own typed port. */
  public override getUnnotifiedBonuses(
    _client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountBonusBatch | null> {
    signal?.throwIfAborted()
    return Promise.resolve(null)
  }

  public override ackBonusNotified(
    _accountId: string,
    _orderId: string,
    _client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted()
    return Promise.resolve(false)
  }

  public async getNotifications(
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<AccountNotificationBatch | null> {
    const value = unwrapRpcResultValue<unknown>(
      await this.remote.remoteRequest('account/getNotifications', { client }, signal),
      'account/getNotifications',
    )
    if (value === null) return null
    const result = batchSchema.safeParse(value)
    if (!result.success) throw malformed()
    return {
      nextPollAfterSeconds: result.data.nextPollAfterSeconds,
      notifications: result.data.notifications.map((notice): AccountNotification => ({
        id: notice.id,
        title: notice.title,
        body: notice.body,
        displayUntil: notice.displayUntil,
        actions: notice.actions.map((action) => ({
          label: action.label,
          style: action.style,
          target: action.target.type === 'dismiss' ? 'dismiss' : 'account',
        })),
      })),
    }
  }

  public async reportNotificationEvent(
    id: string,
    event: AccountNotificationEvent,
    client: AccountClientMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!identifier.safeParse(id).success || !['displayed', 'cta_clicked', 'dismissed'].includes(event))
      throw malformed()
    const value = unwrapRpcResultValue<unknown>(
      await this.remote.remoteRequest('account/reportNotificationEvent', { id, event, client }, signal),
      'account/reportNotificationEvent',
    )
    if (typeof value !== 'boolean') throw malformed()
    return value
  }
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned an invalid rc222 account response.',
    retryable: false,
  })
}
