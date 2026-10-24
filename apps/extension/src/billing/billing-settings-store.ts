import { AppError, type BillingSettings } from '@dsh-vscode/domain'
import type { BillingSettingsPort } from '@dsh-vscode/application'
import { billingConfigurationSchema, billingSettingsSchema } from '@dsh-vscode/webview-protocol'

export interface BillingStateStorage {
  get(key: string): unknown
  update(key: string, value: unknown): PromiseLike<void>
}

/** One writer for all local surfaces/scopes. Nothing is written into a workspace. */
export class BillingSettingsStore {
  private writes: Promise<void> = Promise.resolve()
  public constructor(private readonly storage: BillingStateStorage) {}

  public scope(scopeId: string, signal: AbortSignal): BillingSettingsPort {
    const key = `dsh.billing.v1.${scopeId}`
    const read = (): Promise<BillingSettings> => {
      signal.throwIfAborted()
      const value = this.storage.get(key)
      if (value === undefined) return Promise.resolve({ revision: 0, enabled: false, prices: [] })
      const parsed = billingSettingsSchema.safeParse(value)
      if (!parsed.success)
        throw new AppError({
          code: 'STORAGE_CORRUPT',
          message: 'Stored billing settings are invalid.',
          retryable: false,
        })
      return Promise.resolve(parsed.data)
    }
    return {
      read,
      save: (settings, expectedRevision) => {
        const operation = this.writes.then(async () => {
          signal.throwIfAborted()
          const current = await read()
          if (current.revision !== expectedRevision)
            throw new AppError({
              code: 'SETTINGS_CONFLICT',
              message: 'Billing settings changed. Reload before saving.',
              retryable: true,
            })
          const configuration = billingConfigurationSchema.parse(settings)
          const next = billingSettingsSchema.parse({ ...configuration, revision: current.revision + 1 })
          signal.throwIfAborted()
          await this.storage.update(key, next)
          return next
        })
        this.writes = operation.then(
          () => undefined,
          () => undefined,
        )
        return operation
      },
    }
  }
}
