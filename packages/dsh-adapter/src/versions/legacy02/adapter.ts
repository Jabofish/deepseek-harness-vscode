import type { BackendEndpoint, ExportRepository } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { DshTransport } from '../../contracts.js'
import { LoopbackApiClient } from '../../loopback-api-client.js'
import { LegacyRc1VersionAdapter } from '../legacy01/adapter.js'
import { createLegacyFrameParser } from '../legacy/frame-contract.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6ExportRepository } from '../../repositories/export-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { executeLegacySessionConfigCommand } from '../legacy/command-repository.js'

/** rc.2 adds task frames and the browser-local time-zone prompt field. */
export class LegacyRc2VersionAdapter extends LegacyRc1VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.0.1-rc.2',
    supportedVersion: '0.0.1-rc.2',
    protocolVersion: 'legacy-rc2',
    compatibilityPriority: 15,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }

  public override createTransport(endpoint: BackendEndpoint): DshTransport {
    return new LoopbackApiClient({
      ...this.options,
      endpoint,
      frameParser: createLegacyFrameParser('rc2'),
    })
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      includeClientTimeZone: true,
      executeSessionConfigCommand: (sessionId, command, signal) =>
        executeLegacySessionConfigCommand(transport, sessionId, command, signal),
    })
  }

  protected override createSubagentRepository(transport: DshTransport): Rc6SubagentRepository {
    return new Rc6SubagentRepository(transport, { includeClientTimeZone: true })
  }

  protected override createExportRepository(transport: DshTransport): ExportRepository {
    return new Rc6ExportRepository(transport, this.options.exportFileSystem)
  }
}
