import type { ModelDescriptor, ModelProvider, ModelRepository } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6ModelRepository implements ModelRepository {
  public constructor(private readonly transport: DshTransport) {}

  public listProviders(signal?: AbortSignal): Promise<readonly ModelProvider[]> {
    return unimplemented<Promise<readonly ModelProvider[]>>('rc6 list model providers', [
      'query the upstream provider/config APIs and map all rc6-supported providers',
      'return field metadata but never secret field values',
      'test custom providers and unavailable credentials',
      `signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ])
  }

  public listModels(providerId?: string, signal?: AbortSignal): Promise<readonly ModelDescriptor[]> {
    return unimplemented<Promise<readonly ModelDescriptor[]>>('rc6 list models', [
      'query models dynamically and support an optional provider filter',
      'retain custom model identifiers and reasoning options',
      'cache only within a connection and invalidate on configuration changes',
      `provider ${providerId ?? 'all'}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
