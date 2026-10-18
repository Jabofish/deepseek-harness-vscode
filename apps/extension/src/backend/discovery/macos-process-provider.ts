import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { discoveryCancelled, isDiscoveryCancellation, type DiscoveryProvider } from './provider.js'
import {
  parseDshProcessCandidates,
  resolveEndpointProcesses,
  resolveDshProcessRuntimeVersions,
  runDiscoveryCommand,
} from './process-provider.js'

export class MacOsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'macos-process'
  public readonly phase = 'fallback' as const

  public async discoverEndpoints(
    endpoints: readonly BackendEndpoint[],
    signal?: AbortSignal,
  ): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) throw discoveryCancelled(signal.reason)
    if (process.platform !== 'darwin' || endpoints.length === 0) return []
    try {
      const listeners = await runDiscoveryCommand(
        'lsof',
        ['-nP', '-a', `-iTCP:${endpoints.map((endpoint) => endpoint.port).join(',')}`, '-sTCP:LISTEN'],
        signal,
      )
      return await resolveEndpointProcesses(
        endpoints,
        listeners,
        (pids) => runDiscoveryCommand('ps', ['-p', pids.join(','), '-o', 'pid=,command='], signal),
        signal,
      )
    } catch (error) {
      if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
      return []
    }
  }

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'darwin') return Promise.resolve([])
    return Promise.all([
      runDiscoveryCommand('ps', ['-axo', 'pid=,command='], signal),
      runDiscoveryCommand('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN'], signal),
    ])
      .then(async ([processes, listeners]) => {
        const candidates = await resolveDshProcessRuntimeVersions(
          parseDshProcessCandidates(processes, listeners),
        )
        if (signal?.aborted === true) throw discoveryCancelled(signal.reason)
        return candidates
      })
      .catch((error: unknown) => {
        if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
        return []
      })
  }
}
