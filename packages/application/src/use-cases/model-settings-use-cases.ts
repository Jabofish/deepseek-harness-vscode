import type {
  AgentConfiguration,
  DiscoveredModel,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  PermissionPresetCatalog,
  SessionModelCatalog,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'
import {
  resolveSessionConfigurationForRoster,
  type SessionConfigurationInput,
} from './session-configuration.js'

export class ModelSettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]> {
    return this.backendService.requireBackend().models.listProviders(signal)
  }

  public listPermissionPresets(signal?: AbortSignal): Promise<readonly string[]> {
    const sessions = this.backendService.requireBackend().sessions
    if (sessions.listPermissionPresets === undefined)
      return Promise.reject(
        new AppError({
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'The connected DSH does not provide a permission preset catalog.',
          retryable: false,
        }),
      )
    return sessions.listPermissionPresets(signal)
  }

  public async readPermissionCatalog(signal?: AbortSignal): Promise<PermissionPresetCatalog> {
    const sessions = this.backendService.requireBackend().sessions
    if (sessions.readPermissionCatalog !== undefined) return sessions.readPermissionCatalog(signal)
    return { items: await this.listPermissionPresets(signal) }
  }

  public listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    return this.backendService.requireBackend().models.listModels(providerId, signal)
  }

  public listSessionModels(sessionId: string, signal?: AbortSignal): Promise<SessionModelCatalog> {
    return this.backendService.requireBackend().models.listSessionModels(sessionId, signal)
  }

  public discoverModels(
    input: ModelDiscoveryInput,
    signal?: AbortSignal,
  ): Promise<readonly DiscoveredModel[]> {
    return this.backendService.requireBackend().models.discoverModels(input, signal)
  }

  public async resolveSessionConfiguration(
    requested: SessionConfigurationInput,
    signal?: AbortSignal,
  ): Promise<AgentConfiguration> {
    signal?.throwIfAborted()
    const { presets } = await this.backendService.requireBackend().presets.list(signal)
    signal?.throwIfAborted()
    return resolveSessionConfigurationForRoster(requested, presets)
  }

  public async setSessionConfiguration(
    sessionId: string,
    configuration: SessionConfigurationInput,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    const backend = this.backendService.requireBackend()
    const resolved = await this.resolveSessionConfiguration(configuration, signal)
    if (this.backendService.requireBackend() !== backend)
      throw new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'The DSH connection changed before the session configuration could be applied.',
        retryable: false,
      })
    return backend.sessions.setConfiguration(sessionId, resolved, signal)
  }
}
