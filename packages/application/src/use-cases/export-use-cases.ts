import type { SessionExportOptions } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class ExportUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('export a DSH session', [
      'accept destination only from a VS Code save dialog',
      'stream through ExportRepository and report progress without buffering the whole export',
      'clean only the incomplete destination created by this operation on cancellation',
      `session ${options.sessionId}; format ${options.format}; destination length ${destination.length}; signal present ${String(signal !== undefined)}; backend guard ${String(this.backendService !== undefined)}`,
    ])
  }
}
