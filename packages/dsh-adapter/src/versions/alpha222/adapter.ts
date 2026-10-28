import {
  AppError,
  type BackendEndpoint,
  type BackendEvent,
  type PluginBundleRepository,
} from '@dsh-vscode/domain'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type { Rc6SessionRepositoryOptions } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { Rc214VersionAdapter } from '../rc214/adapter.js'
import { Alpha222SessionRepository } from './session-repository.js'
import { Alpha222PluginBundleRepository } from './plugin-manager-repository.js'
import { alpha222SessionProfile } from './session-wire.js'
import { normalizeAlpha222GlobalEvent } from './interaction-events.js'

/** dsh-v0.2.2-alpha.2 / f3803c96974ad4a94195fb97e5c637e9c2a3afe3. */
export class Alpha222VersionAdapter extends Rc214VersionAdapter {
  protected override createGlobalEventNormalizer(): (frame: unknown) => BackendEvent | undefined {
    return normalizeAlpha222GlobalEvent
  }
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.2-alpha.2',
    supportedVersion: '0.2.2-alpha.2',
    protocolVersion: 'alpha222',
    compatibilityPriority: 360,
    fallback: false,
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionWireProfile: alpha222SessionProfile,
      activateSessionFollow: true,
    }
  }

  protected override createSessionRepository(
    transport: AlphaLoopbackApiClient,
    workspaces: Rc6WorkspaceRepository,
    options: Rc6SessionRepositoryOptions,
  ): Alpha222SessionRepository {
    return new Alpha222SessionRepository(transport, workspaces, this.options.samePath, options)
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Alpha222PluginBundleRepository(transport)
  }

  protected override mapBackendEvent(event: BackendEvent): BackendEvent {
    if (event.type === 'remote.event' && event.name === 'llm/models-updated') {
      if (event.args.length !== 1 || typeof event.args[0] !== 'string' || event.args[0].trim() === '')
        throw new AppError({
          code: 'PROTOCOL_ERROR',
          message: 'Invalid model catalogue notification.',
          retryable: false,
        })
      return { type: 'remote.event', name: 'llm/adapters-updated', args: [] }
    }
    return super.mapBackendEvent(event)
  }
}
