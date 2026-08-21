import { AppError } from '@dsh-vscode/domain'
import type { DshSettingsSchema } from '@dsh-vscode/domain'

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

  public openDocument(signal?: AbortSignal): Promise<void> {
    const openDocument = this.backendService.requireBackend().settings.openDocument
    if (openDocument === undefined)
      return Promise.reject(
        new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'The connected DSH host cannot open its settings document.',
          retryable: false,
        }),
      )
    return openDocument(signal)
  }
}
