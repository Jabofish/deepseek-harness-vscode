import type {
  AgentConfiguration,
  DiscoveredModel,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  SessionModelCatalog,
} from '@dsh-vscode/domain'

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
    const resolved = await this.resolveSessionConfiguration(configuration, signal)
    return this.backendService.requireBackend().sessions.setConfiguration(sessionId, resolved, signal)
  }
}
