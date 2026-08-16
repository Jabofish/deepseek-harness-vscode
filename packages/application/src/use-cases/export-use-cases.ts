import { AppError, type SessionExportOptions } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class ExportUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
    overwriteConfirmed = false,
  ): Promise<void> {
    if (options.sessionId.trim() === '' || destination.trim() === '')
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'An export session and destination are required.',
        retryable: false,
      })
    return this.backendService
      .requireBackend()
      .exports.exportSession(options, destination, signal, overwriteConfirmed)
  }
}
