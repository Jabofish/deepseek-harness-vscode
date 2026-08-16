import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from '../../contracts.js'
import type { LoopbackApiClientOptions } from '../../loopback-api-client.js'

export type Rc6AdapterOptions = Omit<LoopbackApiClientOptions, 'endpoint'>

export class Rc6VersionAdapter implements DshVersionAdapter {
  public readonly id = 'dsh-0.1.0-rc.6'
  public readonly supportedVersion = '0.1.0-rc.6'

  public constructor(private readonly options: Rc6AdapterOptions) {}

  public probe(candidate: BackendCandidate, signal?: AbortSignal): Promise<BackendCapabilities | undefined> {
    return unimplemented<Promise<BackendCapabilities | undefined>>('rc6 health and capabilities probe', [
      'call only the minimal official rc6 health/version endpoint',
      'verify the response identifies DeepSeek Harness',
      'derive an explicit feature set from server capabilities rather than optimistic assumptions',
      'return undefined for connection refused and unrelated services',
      `candidate ${candidate.endpoint.baseUrl}; timeout ${this.options.requestTimeoutMs}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public createTransport(endpoint: BackendEndpoint): DshTransport {
    return unimplemented<DshTransport>('create rc6 transport', [
      'construct LoopbackApiClient with the selected endpoint and immutable options',
      'do not expose rc6 transport types above the adapter package',
      `endpoint ${endpoint.baseUrl}`,
    ])
  }
}
