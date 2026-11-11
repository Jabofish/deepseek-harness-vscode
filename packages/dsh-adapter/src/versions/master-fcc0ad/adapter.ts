import {
  AppError,
  type BackendEndpoint,
  type BackendEvent,
  type SessionProjectionValues,
} from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import type { Alpha171AdapterOptions } from '../alpha171/adapter.js'
import { Rc221VersionAdapter } from '../rc221/adapter.js'
import { assertMasterFcc0adCommit, MASTER_FCC0AD_COMMIT, MASTER_FCC0AD_RUNTIME_VERSION } from './identity.js'
import { masterFcc0adSessionProfile } from './session-wire.js'
import { MasterFcc0adClient } from './client.js'
import { MasterFcc0adSubagentRepository } from './subagent-repository.js'
import {
  masterIdentifier,
  masterMcpStatusSchema,
  parseMasterContract,
  parseMasterContinuation,
} from './contracts.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { mapMasterPublicProjection, mapMasterPublicProjectionValues } from './projections.js'

/** Commit-scoped preparation. The Host establishes source identity before construction. */
export class MasterFcc0adVersionAdapter extends Rc221VersionAdapter {
  public constructor(options: Alpha171AdapterOptions, sourceCommit: string) {
    assertMasterFcc0adCommit(sourceCommit)
    super(options)
  }

  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-master-fcc0ad',
    supportedVersion: MASTER_FCC0AD_RUNTIME_VERSION,
    protocolVersion: 'master-fcc0ad',
    compatibilityPriority: 0,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    const options = super.createTransportOptions(endpoint)
    return {
      ...options,
      subagentControlWire: 'user-v2',
      sessionWireProfile: masterFcc0adSessionProfile,
      normalizeControlFrame: (value) => {
        const frames = options.normalizeControlFrame?.(value)
        for (const value of frames ?? []) {
          const frame = recordOrUndefined(value)
          if (frame?.type === 'session/projection' && frame.key === 'conversationContinuation')
            parseMasterContinuation(frame.value, frame.seq as number)
          if (frame?.type === 'session/projection-baseline')
            for (const value of Object.values(recordOrUndefined(frame.projections) ?? {})) {
              const projection = recordOrUndefined(value)
              const values = recordOrUndefined(projection?.values)
              if (values !== undefined && Object.hasOwn(values, 'conversationContinuation'))
                parseMasterContinuation(values.conversationContinuation, projection?.asOfSequence as number)
            }
        }
        return frames
      },
    }
  }

  protected override createSubagentRepository(
    transport: AlphaLoopbackApiClient,
    options: SubagentRepositoryOptions,
  ): MasterFcc0adSubagentRepository {
    return new MasterFcc0adSubagentRepository(transport, options)
  }

  protected override mapProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return mapMasterPublicProjectionValues(super.mapProjectionValues(values))
  }

  protected override mapBackendEvent(event: BackendEvent): BackendEvent {
    const mapped = super.mapBackendEvent(event)
    if (mapped.type === 'remote.event' && mapped.name === 'mcp-manager/status') {
      if (mapped.args.length !== 2)
        throw new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'Invalid MCP status notification.',
          retryable: false,
        })
      const name = parseMasterContract(masterIdentifier, mapped.args[0], 'mcp-manager/status')
      parseMasterContract(masterMcpStatusSchema, mapped.args[1], 'mcp-manager/status')
      return { type: 'remote.event', name: mapped.name, args: [name] }
    }
    if (mapped.type === 'session.projection') {
      mapMasterPublicProjectionValues({ [mapped.key]: mapped.value })
      return mapped.key === 'agentTeam' ? { type: 'session.system', sessionId: mapped.sessionId } : mapped
    }
    if (mapped.type === 'session.subscribed' && mapped.projection !== undefined)
      return { ...mapped, projection: mapMasterPublicProjection(mapped.projection) }
    if (mapped.type === 'session.projection.baseline')
      return {
        ...mapped,
        projections: Object.fromEntries(
          Object.entries(mapped.projections).map(([sessionId, projection]) => [
            sessionId,
            mapMasterPublicProjection(projection),
          ]),
        ),
      }
    return mapped
  }

  /** The caller closes this independently owned preparation client. */
  public createPreparationClient(endpoint: BackendEndpoint): MasterFcc0adClient {
    return new MasterFcc0adClient(this.createTransportOptions(endpoint), MASTER_FCC0AD_COMMIT)
  }
}
