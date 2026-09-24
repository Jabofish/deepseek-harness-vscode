import type { BackendDiscovery } from '@dsh-vscode/application'
import type { BackendCandidate } from '@dsh-vscode/domain'
import { isDshPackageVersion } from '@dsh-vscode/dsh-adapter'

import { discoveryCancelled, type DiscoveryProvider } from './provider.js'

export class CompositeInstanceDiscovery implements BackendDiscovery {
  public constructor(private readonly providers: readonly DiscoveryProvider[]) {}

  public async discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return this.discoverProviders(this.providers, signal)
  }

  public async discoverFast(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return this.discoverProviders(
      this.providers.filter((provider) => provider.phase !== 'fallback'),
      signal,
    )
  }

  private async discoverProviders(
    providers: readonly DiscoveryProvider[],
    signal?: AbortSignal,
  ): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted) throw discoveryCancelled(signal.reason)
    const results = await Promise.allSettled(providers.map((provider) => provider.discover(signal)))
    // allSettled deliberately isolates stale optional discovery providers, but
    // it must not turn a caller cancellation into a successful empty result.
    if (signal?.aborted) throw discoveryCancelled(signal.reason)
    const byEndpoint = new Map<string, BackendCandidate[]>()
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      for (const candidate of result.value) {
        if (!isLoopbackCandidate(candidate)) continue
        const key = `${candidate.endpoint.host}:${candidate.endpoint.port}`
        const existing = byEndpoint.get(key)
        if (existing === undefined) byEndpoint.set(key, [candidate])
        else existing.push(candidate)
      }
    }
    return [...byEndpoint.values()].map(mergeEndpointCandidates).sort((left, right) => {
      const score = rank(right) - rank(left)
      if (score !== 0) return score
      return left.endpoint.port - right.endpoint.port
    })
  }
}

function mergeEndpointCandidates(candidates: readonly BackendCandidate[]): BackendCandidate {
  const winner = candidates.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best))
  const processes = candidates.filter((candidate) => candidate.source === 'process-scan')
  const processPids = new Set(
    processes.flatMap((candidate) =>
      candidate.pid !== undefined && Number.isSafeInteger(candidate.pid) && candidate.pid > 0
        ? [candidate.pid]
        : [],
    ),
  )
  const manifestEvidence = processes.filter(
    (candidate) => candidate.runtimeVersionEvidence === 'process-manifest',
  )
  const verifiedManifestEvidence = manifestEvidence.filter(
    (candidate) =>
      candidate.runtimeVersion !== undefined &&
      isDshPackageVersion(candidate.runtimeVersion) &&
      candidate.pid !== undefined &&
      Number.isSafeInteger(candidate.pid) &&
      candidate.pid > 0 &&
      processPids.has(candidate.pid) &&
      candidate.commandLine !== undefined &&
      candidate.commandLine.trim() !== '',
  )
  const malformedManifest = verifiedManifestEvidence.length !== manifestEvidence.length
  const distinctVersions = new Set(
    verifiedManifestEvidence.flatMap((candidate) =>
      candidate.runtimeVersion === undefined ? [] : [candidate.runtimeVersion],
    ),
  )
  const processIdentityConflict = processPids.size > 1
  const uniqueProcessPid = processPids.size === 1 ? [...processPids][0] : undefined
  const runtimeVersion =
    !malformedManifest &&
    verifiedManifestEvidence.length > 0 &&
    !processIdentityConflict &&
    uniqueProcessPid !== undefined &&
    verifiedManifestEvidence.every((candidate) => candidate.pid === uniqueProcessPid) &&
    distinctVersions.size === 1
      ? [...distinctVersions][0]
      : undefined
  const processIdentity =
    runtimeVersion === undefined || uniqueProcessPid === undefined
      ? undefined
      : verifiedManifestEvidence.find(
          (candidate) =>
            candidate.pid === uniqueProcessPid &&
            candidate.commandLine !== undefined &&
            candidate.commandLine.trim() !== '',
        )
  const {
    runtimeVersion: discardedVersion,
    runtimeVersionEvidence: discardedEvidence,
    pid: discardedPid,
    commandLine: discardedCommandLine,
    ...winnerWithoutIdentity
  } = winner
  void discardedVersion
  void discardedEvidence
  void discardedPid
  void discardedCommandLine

  return {
    ...winnerWithoutIdentity,
    ...(runtimeVersion === undefined
      ? {}
      : { runtimeVersion, runtimeVersionEvidence: 'process-manifest' as const }),
    ...(processIdentity === undefined
      ? {}
      : {
          pid: processIdentity.pid,
          ...(processIdentity.commandLine === undefined ? {} : { commandLine: processIdentity.commandLine }),
        }),
  }
}

function rank(candidate: BackendCandidate): number {
  const sourceWeight: Record<BackendCandidate['source'], number> = {
    configured: 50,
    known: 40,
    companion: 30,
    'process-scan': 20,
    'default-port': 10,
  }
  return sourceWeight[candidate.source] * 1000 + candidate.confidence
}

function isLoopbackCandidate(candidate: BackendCandidate): boolean {
  return (
    (candidate.endpoint.host === '127.0.0.1' || candidate.endpoint.host === 'localhost') &&
    Number.isInteger(candidate.endpoint.port) &&
    candidate.endpoint.port >= 1 &&
    candidate.endpoint.port <= 65535 &&
    candidate.endpoint.baseUrl === `http://${candidate.endpoint.host}:${candidate.endpoint.port}`
  )
}
