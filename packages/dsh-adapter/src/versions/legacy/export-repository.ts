import { type ExportRepository, type SessionExportOptions } from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { Rc6ExportRepository, type ExportFileSystem } from '../../repositories/export-repository.js'
import { unavailable } from '../rc6/rpc.js'

/** rc.1 has history export but predates the host-side ZIP download surface. */
export class LegacyRc1ExportRepository implements ExportRepository {
  private readonly delegate: Rc6ExportRepository

  public constructor(transport: DshTransport, fileSystem?: ExportFileSystem) {
    this.delegate = new Rc6ExportRepository(transport, fileSystem)
  }

  public exportSession(
    options: SessionExportOptions,
    destination: string,
    signal?: AbortSignal,
    overwriteConfirmed?: boolean,
  ): Promise<void> {
    if (options.format === 'zip') return Promise.reject(unavailable('legacy session ZIP export'))
    return this.delegate.exportSession(options, destination, signal, overwriteConfirmed)
  }
}
