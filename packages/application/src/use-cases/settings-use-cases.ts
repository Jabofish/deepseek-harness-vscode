import { AppError } from '@dsh-vscode/domain'
import type { DshSettingsSchema, SettingsPathOperation } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class SettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public read(
    signal?: AbortSignal,
  ): Promise<{ readonly schema: DshSettingsSchema; readonly values: Readonly<Record<string, unknown>> }> {
    const backend = this.backendService.requireBackend()
    return Promise.all([backend.settings.schema(signal), backend.settings.read(signal)]).then(
      ([schema, values]) => ({ schema, values }),
    )
  }

  public update(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
    if (path.trim() === '') throw new Error('Settings path is required')
    return this.backendService.requireBackend().settings.update(path, value, signal)
  }

  public unset(path: string, signal?: AbortSignal): Promise<void> {
    if (path.trim() === '') throw new Error('Settings path is required')
    return this.backendService.requireBackend().settings.unset(path, signal)
  }

  public mutate(
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (namespace.trim() === '') throw new Error('Settings namespace is required')
    if (operations.length === 0) throw new Error('At least one settings operation is required')
    return this.backendService
      .requireBackend()
      .settings.mutate(namespace, operations, expectedRevision, signal)
  }

  public openDocument(signal?: AbortSignal): Promise<void> {
    const repository = this.backendService.requireBackend().settings
    if (repository.openDocument === undefined)
      return Promise.reject(
        new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'The connected DSH host cannot open its settings document.',
          retryable: false,
        }),
      )
    // Keep the call on the repository object: adapter methods use `this.transport`.
    return repository.openDocument(signal)
  }
}
