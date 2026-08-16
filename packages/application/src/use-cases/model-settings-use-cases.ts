import type { AgentConfiguration, ModelDescriptor, ModelProvider } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class ModelSettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]> {
    return unimplemented<Promise<readonly ModelProvider[]>>('list model providers', [
      'read provider definitions from DSH rather than hard-coding providers in the Webview',
      'redact all secret values before returning domain objects',
      `signal present: ${String(signal !== undefined)}; backend guard available: ${String(this.backendService !== undefined)}`,
    ])
  }

  public listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    return unimplemented<Promise<readonly ModelDescriptor[]>>('list models', [
      'delegate to DSH model discovery',
      'include custom and provider-defined models supported by the connected version',
      `provider filter: ${providerId ?? 'none'}; signal present: ${String(signal !== undefined)}`,
    ])
  }

  public setSessionConfiguration(
    sessionId: string,
    configuration: AgentConfiguration,
    signal?: AbortSignal,
  ): Promise<void> {
    return unimplemented<Promise<void>>('update per-session agent configuration', [
      'validate preset, tools mode, permission preset, plan mode, provider, model, and reasoning level',
      'persist through DSH using the rc6 mapping and refresh the session snapshot',
      `session: ${sessionId}; preset: ${configuration.preset}; signal present: ${String(signal !== undefined)}`,
    ])
  }
}
