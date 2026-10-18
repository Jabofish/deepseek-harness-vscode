import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { discoveryCancelled, isDiscoveryCancellation, type DiscoveryProvider } from './provider.js'
import {
  parseDshProcessCandidates,
  resolveEndpointProcesses,
  resolveDshProcessRuntimeVersions,
  runDiscoveryCommand,
} from './process-provider.js'

export class LinuxProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'linux-process'
  public readonly phase = 'fallback' as const

  public async discoverEndpoints(
    endpoints: readonly BackendEndpoint[],
    signal?: AbortSignal,
  ): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) throw discoveryCancelled(signal.reason)
    if (process.platform !== 'linux' || endpoints.length === 0) return []
    try {
      const filter = endpoints.map((endpoint) => `sport = :${endpoint.port}`).join(' or ')
      const listeners = await runDiscoveryCommand('ss', ['-ltnp', `( ${filter} )`], signal)
      return await resolveEndpointProcesses(
        endpoints,
        listeners,
        (pids) => runDiscoveryCommand('ps', ['-p', pids.join(','), '-o', 'pid=,args='], signal),
        signal,
      )
    } catch (error) {
      if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
      return []
    }
  }

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'linux') return Promise.resolve([])
    return Promise.all([
      runDiscoveryCommand('ps', ['-eo', 'pid=,args='], signal),
      runDiscoveryCommand('ss', ['-ltnp'], signal),
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
