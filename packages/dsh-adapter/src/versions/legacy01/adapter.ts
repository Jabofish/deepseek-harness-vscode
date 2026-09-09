import { type BackendEndpoint, type CommandRepository, type ExportRepository } from '@dsh-vscode/domain'

import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { DshTransport } from '../../contracts.js'
import { LoopbackApiClient } from '../../loopback-api-client.js'
import { LegacyCommandRepository, executeLegacySessionConfigCommand } from '../legacy/command-repository.js'
import { LegacyRc1ExportRepository } from '../legacy/export-repository.js'
import { createLegacyFrameParser } from '../legacy/frame-contract.js'
import { LegacyWorkspaceRepository } from '../legacy/workspace-repository.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6VersionAdapter } from '../rc6/adapter.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'

/** Exact adapter for the first published Host API contract. */
export class LegacyRc1VersionAdapter extends Rc6VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.0.1-rc.1',
    supportedVersion: '0.0.1-rc.1',
    protocolVersion: 'legacy-rc1',
    compatibilityPriority: 10,
    fallback: false,
  }

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }

  public override createTransport(endpoint: BackendEndpoint): DshTransport {
    return new LoopbackApiClient({
      ...this.options,
      endpoint,
      frameParser: createLegacyFrameParser('rc1'),
    })
  }

  protected override createCommandRepository(transport: DshTransport): CommandRepository {
    return new LegacyCommandRepository(transport)
  }

  protected override createWorkspaceRepository(transport: DshTransport): Rc6WorkspaceRepository {
    return new LegacyWorkspaceRepository(transport)
  }

  protected override createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      includeClientTimeZone: false,
      executeSessionConfigCommand: (sessionId, command, signal) =>
        executeLegacySessionConfigCommand(transport, sessionId, command, signal),
    })
  }

  protected override createSubagentRepository(transport: DshTransport): Rc6SubagentRepository {
    return new Rc6SubagentRepository(transport, { includeClientTimeZone: false })
  }

  protected override createExportRepository(transport: DshTransport): ExportRepository {
    return new LegacyRc1ExportRepository(transport, this.options.exportFileSystem)
  }
}
