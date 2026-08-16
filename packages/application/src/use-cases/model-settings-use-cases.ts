import type {
  AgentConfiguration,
  DiscoveredModel,
  ModelDescriptor,
  ModelDiscoveryInput,
  ModelProvider,
  SessionModelCatalog,
} from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

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

  public setSessionConfiguration(
    sessionId: string,
    configuration: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.backendService.requireBackend().sessions.setConfiguration(sessionId, configuration, signal)
  }
}
