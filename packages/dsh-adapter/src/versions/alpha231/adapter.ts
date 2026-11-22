import type {
  BackendEndpoint,
  BackendEvent,
  SessionProjectionSnapshot,
  SessionProjectionValues,
} from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { DshTransport } from '../../contracts.js'
import type { SubagentRepositoryOptions } from '../../repositories/subagent-repository.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Rc222SubagentRepository } from '../rc222/subagent-repository.js'
import { mapRc222PublicProjection } from '../rc222/projections.js'
import { Rc225VersionAdapter } from '../rc225/adapter.js'
import { alpha231SessionProfile } from './session-wire.js'

/** dsh-v0.2.3-alpha.1 / d98f5d68519215da48f3002da2cb9c9d2068d81d. */
export class Alpha231VersionAdapter extends Rc225VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.3-alpha.1',
    supportedVersion: '0.2.3-alpha.1',
    protocolVersion: 'alpha231',
    compatibilityPriority: 430,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return { ...super.createTransportOptions(endpoint), sessionWireProfile: alpha231SessionProfile }
  }

  protected override mapProjectionValues(values: Readonly<Record<string, unknown>>): SessionProjectionValues {
    return withoutActionCards(super.mapProjectionValues(values))
  }

  protected override createSubagentRepository(
    transport: DshTransport,
    options: SubagentRepositoryOptions,
  ): Rc222SubagentRepository {
    return new Rc222SubagentRepository(transport, options, (projection) =>
      sanitizeProjection(mapRc222PublicProjection(projection)),
    )
  }

  protected override mapBackendEvent(event: BackendEvent): BackendEvent {
    const mapped = super.mapBackendEvent(event)
    if (mapped.type === 'session.projection' && mapped.key === 'actionCards')
      return { type: 'session.system', sessionId: mapped.sessionId }
    if (mapped.type === 'session.subscribed' && mapped.projection !== undefined)
      return {
        ...mapped,
        projection: sanitizeProjection(mapped.projection),
      }
    if (mapped.type === 'session.projection.baseline')
      return {
        ...mapped,
        projections: Object.fromEntries(
          Object.entries(mapped.projections).map(([id, projection]) => [id, sanitizeProjection(projection)]),
        ),
      }
    return mapped
  }
}

function sanitizeProjection(projection: SessionProjectionSnapshot): SessionProjectionSnapshot {
  return { ...projection, values: withoutActionCards(projection.values) }
}

function withoutActionCards(values: SessionProjectionValues): SessionProjectionValues {
  if (!Object.hasOwn(values, 'actionCards')) return values
  const { actionCards, ...publicValues } = values
  void actionCards
  return publicValues
}
