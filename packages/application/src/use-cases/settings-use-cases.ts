import { AppError } from '@dsh-vscode/domain'
import type { DshSettingsSchema, SettingsPathOperation } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class SettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public read(
    signal?: AbortSignal,
  ): Promise<{ readonly schema: DshSettingsSchema; readonly values: Readonly<Record<string, unknown>> }> {
    return this.backendService.requireBackend().settings.readSnapshot(signal)
  }

  public update(path: string, value: unknown, expectedRevision: number, signal?: AbortSignal): Promise<void> {
    if (path.trim() === '') throw new Error('Settings path is required')
    requireRevision(expectedRevision)
    return this.backendService.requireBackend().settings.update(path, value, expectedRevision, signal)
  }

  public unset(path: string, expectedRevision: number, signal?: AbortSignal): Promise<void> {
    if (path.trim() === '') throw new Error('Settings path is required')
    requireRevision(expectedRevision)
    return this.backendService.requireBackend().settings.unset(path, expectedRevision, signal)
  }

  public mutate(
    namespace: string,
    operations: readonly SettingsPathOperation[],
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (namespace.trim() === '') throw new Error('Settings namespace is required')
    if (operations.length === 0) throw new Error('At least one settings operation is required')
    requireRevision(expectedRevision)
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

function requireRevision(value: number): void {
  if (Number.isSafeInteger(value) && value >= 0) return
  throw new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'The settings revision is invalid.',
    retryable: false,
  })
}
