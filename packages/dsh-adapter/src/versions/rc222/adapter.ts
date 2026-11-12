import {
  AppError,
  type BackendEndpoint,
  type BackendEvent,
  type SessionProjectionValues,
} from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import { recordOrUndefined } from '../../repositories/shared/guards.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Rc221VersionAdapter } from '../rc221/adapter.js'
import { rc222SessionProfile } from './session-wire.js'
import { Rc222SubagentRepository } from './subagent-repository.js'
import {
  rc222Identifier,
  rc222McpStatusSchema,
  parseRc222Contract,
  parseRc222Continuation,
} from './contracts.js'
import { mapRc222PublicProjection, mapRc222PublicProjectionValues } from './projections.js'
import { Rc222AccountLifecycleRepository } from './account-repository.js'
import { Rc222PluginBundleRepository } from './plugin-manager-repository.js'

/** dsh-v0.2.2-rc.2 / ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c. */
export class Rc222VersionAdapter extends Rc221VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-rc.2',
    supportedVersion: '0.2.2-rc.2',
    protocolVersion: 'rc222',
    compatibilityPriority: 390,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    const options = super.createTransportOptions(endpoint)
    return {
      ...options,
      subagentControlWire: 'user-v2',
      sessionWireProfile: rc222SessionProfile,
      normalizeControlFrame: (value) => {
        const frames = options.normalizeControlFrame?.(value)
        for (const value of frames ?? []) {
          const frame = recordOrUndefined(value)
          if (frame?.type === 'session/projection' && frame.key === 'conversationContinuation')
            parseRc222Continuation(frame.value, frame.seq as number)
          if (frame?.type === 'session/projection-baseline')
            for (const value of Object.values(recordOrUndefined(frame.projections) ?? {})) {
              const projection = recordOrUndefined(value)
              const values = recordOrUndefined(projection?.values)
              if (values !== undefined && Object.hasOwn(values, 'conversationContinuation'))
                parseRc222Continuation(values.conversationContinuation, projection?.asOfSequence as number)
            }
        }
        return frames
      },
    }
  }

  protected override createAccountLifecycleRepository(
    transport: AlphaLoopbackApiClient,
  ): Rc222AccountLifecycleRepository {
    return new Rc222AccountLifecycleRepository(transport)
  }

  protected override createPluginBundleRepository(
    transport: AlphaLoopbackApiClient,
  ): Rc222PluginBundleRepository {
    return new Rc222PluginBundleRepository(transport)
  }

  protected override createSubagentRepository(
    transport: AlphaLoopbackApiClient,
    options: SubagentRepositoryOptions,
  ): Rc222SubagentRepository {
    return new Rc222SubagentRepository(transport, options)
  }

  protected override mapProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return mapRc222PublicProjectionValues(super.mapProjectionValues(values))
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
      const name = parseRc222Contract(rc222Identifier, mapped.args[0], 'mcp-manager/status')
      parseRc222Contract(rc222McpStatusSchema, mapped.args[1], 'mcp-manager/status')
      return { type: 'remote.event', name: mapped.name, args: [name] }
    }
    if (mapped.type === 'session.projection') {
      mapRc222PublicProjectionValues({ [mapped.key]: mapped.value })
      return mapped.key === 'agentTeam' ? { type: 'session.system', sessionId: mapped.sessionId } : mapped
    }
    if (mapped.type === 'session.subscribed' && mapped.projection !== undefined)
      return { ...mapped, projection: mapRc222PublicProjection(mapped.projection) }
    if (mapped.type === 'session.projection.baseline')
      return {
        ...mapped,
        projections: Object.fromEntries(
          Object.entries(mapped.projections).map(([id, projection]) => [
            id,
            mapRc222PublicProjection(projection),
          ]),
        ),
      }
    return mapped
  }
}
