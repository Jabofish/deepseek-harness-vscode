import type { ExportRepository, SessionExportOptions } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6ExportRepository implements ExportRepository {
  public constructor(private readonly transport: DshTransport) {}

  public exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('rc6 session and attachment export', [
      'stream official session history and optional attachments to an Extension Host save destination',
      'support markdown, JSON, and ZIP with deterministic metadata and bounded memory',
      'sanitize archive paths and never overwrite without VS Code save confirmation',
      'delete only an incomplete output owned by this export when cancelled or failed',
      `session ${options.sessionId}; format ${options.format}; destination length ${destination.length}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ])
  }
}
