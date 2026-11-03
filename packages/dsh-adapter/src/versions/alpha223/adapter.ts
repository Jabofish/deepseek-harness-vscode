import type { BackendEndpoint, ScheduleRepository } from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Alpha222VersionAdapter } from '../alpha222/adapter.js'
import { Alpha223ScheduleRepository } from './schedule-repository.js'
import { normalizeAlpha223ControlFrame } from './session-control.js'

/** Exact dsh-v0.2.2-alpha.3 / 05b1cae8db6e674c5685101494d4eec24652424a. */
export class Alpha223VersionAdapter extends Alpha222VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-alpha.3',
    supportedVersion: '0.2.2-alpha.3',
    protocolVersion: 'alpha223',
    compatibilityPriority: 370,
    fallback: false,
  }
  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      normalizeControlFrame: (value) => {
        const frames = normalizeAlpha223ControlFrame(value)
        // Semantic validators must finish before any member of a batch is published.
        for (const frame of frames ?? []) {
          if (frame.type === 'session/projection')
            this.mapBackendEvent({
              type: 'session.projection',
              sessionId: frame.sessionId,
              key: frame.key,
              value: frame.value,
            })
          else if (frame.type === 'session/projection-baseline')
            for (const projection of Object.values(frame.projections))
              this.mapProjectionValues(projection.values)
        }
        return frames
      },
    }
  }
  protected override createScheduleRepository(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return new Alpha223ScheduleRepository(transport)
  }
}
