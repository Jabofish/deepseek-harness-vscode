import {
  AppError,
  isCanonicalEndpoint,
  isLoopbackEndpoint,
  type BackendCandidate,
  type BackendEndpoint,
  type BackendState,
  type ConnectedBackend,
  type ConnectionProgress,
  type DshBackend,
  type ManagedProcessHandle,
} from '@dsh-vscode/domain'

import type {
  BackendDiscovery,
  BackendFactory,
  BackendEndpointPreparation,
  BackendProbe,
  ConnectionRequest,
  ProcessSupervisor,
  RuntimeLocator,
  RuntimeLookupResult,
} from './ports.js'

export interface ConnectionCoordinatorDependencies {
  readonly runtimeLocator: RuntimeLocator
  readonly discovery: BackendDiscovery
  readonly probe: BackendProbe
  readonly backendFactory: BackendFactory
  readonly processSupervisor: ProcessSupervisor
  readonly endpointPreparation?: BackendEndpointPreparation
  readonly onProgress?: (progress: ConnectionProgress) => void
}

export interface ConnectionResult {
  readonly backend: DshBackend
  readonly state: Extract<BackendState, { readonly kind: 'connected' }>
}

export class DshConnectionCoordinator {
  private state: BackendState = { kind: 'idle' }
  private readonly listeners = new Set<(state: BackendState) => void>()
  private inFlight: Promise<ConnectionResult> | undefined
  private inFlightRequest: ConnectionRequest | undefined
  private backend: DshBackend | undefined
  private connectedRequest: ConnectionRequest | undefined
  private readonly orphanedBackends = new Set<DshBackend>()
  private managedProcess: ManagedProcessHandle | undefined
  private operationAbort: AbortController | undefined
  private disconnectOperation: Promise<void> | undefined
  private generation = 0
  private disconnectIntent = 0

  public constructor(private readonly dependencies: ConnectionCoordinatorDependencies) {}

  public getState(): BackendState {
    return this.state
  }

  public subscribe(listener: (state: BackendState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  public async connect(request: ConnectionRequest, signal?: AbortSignal): Promise<ConnectionResult> {
    this.throwIfAborted(signal)
    const disconnectIntent = this.disconnectIntent
    if (this.disconnectOperation !== undefined) {
      await waitForSignal(this.disconnectOperation, signal)
      if (this.disconnectIntent !== disconnectIntent) throw cancelled(signal?.reason)
    }
    this.throwIfAborted(signal)
    if (this.inFlight !== undefined) {
      if (!sameRequest(this.inFlightRequest, request))
        throw new AppError({
          code: 'BACKEND_BUSY',
          message: 'Another DSH connection operation is already in progress.',
          retryable: true,
        })
      return waitForSignal(this.inFlight, signal)
    }
    if (
      this.orphanedBackends.size > 0 ||
      (this.state.kind === 'failed' && (this.backend !== undefined || this.managedProcess !== undefined))
    ) {
      await this.disconnectForReplacement()
      this.throwIfAborted(signal)
      if (this.disconnectIntent !== disconnectIntent) throw cancelled(signal?.reason)
    }
    if (
      this.backend !== undefined &&
      (!sameRequest(this.connectedRequest, request) ||
        shouldDisconnectForRequest(this.backend.connection.endpoint, request))
    )
      await this.disconnectForReplacement()
    this.throwIfAborted(signal)
    if (this.disconnectIntent !== disconnectIntent) throw cancelled(signal?.reason)
    const generation = ++this.generation
    const operationAbort = new AbortController()
    this.operationAbort = operationAbort
    const operationSignal = combineSignals(signal, operationAbort.signal)
    if (this.backend === undefined) this.progress({ phase: 'connect', status: 'started', mode: request.mode })
    const operation = this.connectOnce(request, operationSignal, generation).catch((error: unknown) => {
      if (generation === this.generation)
        this.progress({
          phase: 'connect',
          status: isCancellation(error, operationSignal) ? 'cancelled' : 'failed',
          code: isCancellation(error, operationSignal)
            ? 'REQUEST_CANCELLED'
            : error instanceof AppError
              ? error.code
              : 'INTERNAL_ERROR',
        })
      if (
        generation === this.generation &&
        isCancellation(error, operationSignal) &&
        this.managedProcess === undefined &&
        this.orphanedBackends.size === 0
      ) {
        const state: BackendState =
          this.backend === undefined
            ? { kind: 'idle' }
            : { kind: 'connected', backend: this.backend.connection }
        this.publish(state)
      }
      throw error
    })
    this.inFlight = operation
    this.inFlightRequest = request
    void operation.then(
      () => {
        if (generation === this.generation && this.backend !== undefined) this.connectedRequest = request
        if (this.inFlight === operation) {
          this.inFlight = undefined
          this.inFlightRequest = undefined
        }
        if (this.operationAbort === operationAbort) this.operationAbort = undefined
      },
      () => {
        if (this.inFlight === operation) {
          this.inFlight = undefined
          this.inFlightRequest = undefined
        }
        if (this.operationAbort === operationAbort) this.operationAbort = undefined
      },
    )
    return operation
  }

  public disconnect(): Promise<void> {
    this.disconnectIntent += 1
    if (this.disconnectOperation !== undefined) {
      // A second explicit disconnect also cancels connect requests that are
      // waiting for an internal replacement teardown to finish.
      this.generation += 1
      this.operationAbort?.abort()
      return this.disconnectOperation
    }
    return this.beginDisconnect()
  }

  private disconnectForReplacement(): Promise<void> {
    if (this.disconnectOperation !== undefined) return this.disconnectOperation
    return this.beginDisconnect()
  }

  private beginDisconnect(): Promise<void> {
    const operation = this.disconnectOnce()
    this.disconnectOperation = operation
    void operation.then(
      () => {
        if (this.disconnectOperation === operation) this.disconnectOperation = undefined
      },
      () => {
        if (this.disconnectOperation === operation) this.disconnectOperation = undefined
      },
    )
    return operation
  }

  private async disconnectOnce(): Promise<void> {
    // Invalidate every in-flight discovery/probe/start operation before
    // waiting for it.  attach() also checks this generation, so a late probe
    // cannot resurrect a backend after the extension has started shutting down.
    this.generation += 1
    this.operationAbort?.abort()
    await this.inFlight?.catch(() => undefined)

    const backend = this.backend
    const backends = new Set(this.orphanedBackends)
    if (backend !== undefined) backends.add(backend)
    const managed = this.managedProcess
    this.publish({
      kind: 'stopping',
      ownership:
        managed === undefined
          ? (backend?.connection.ownership ?? [...backends][0]?.connection.ownership ?? 'external')
          : 'managed',
    })
    const closeErrors: unknown[] = []
    let stopError: unknown
    let stopFailed = false
    for (const pendingBackend of backends) {
      try {
        await pendingBackend.close()
        this.orphanedBackends.delete(pendingBackend)
        if (this.backend === pendingBackend) this.backend = undefined
      } catch (error) {
        closeErrors.push(error)
      }
    }
    if (managed !== undefined) {
      try {
        await managed.stop()
        if (this.managedProcess === managed) this.managedProcess = undefined
      } catch (error) {
        stopFailed = true
        stopError = error
      }
    }
    if (closeErrors.length > 0 || stopFailed) {
      this.publish({
        kind: 'failed',
        message: 'The DSH connection could not be closed cleanly.',
        retryable: true,
      })
      const failures = [...closeErrors, ...(stopFailed ? [stopError] : [])]
      if (failures.length === 1) throw failures[0]
      throw new AggregateError(
        failures,
        'The DSH connection and managed process could not be closed cleanly.',
        {
          cause: failures[0],
        },
      )
    }
    this.publish({ kind: 'idle' })
  }

  private async connectOnce(
    request: ConnectionRequest,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<ConnectionResult> {
    this.throwIfAborted(signal)
    if (
      this.backend !== undefined &&
      sameRequest(this.connectedRequest, request) &&
      !shouldDisconnectForRequest(this.backend.connection.endpoint, request)
    ) {
      const state: Extract<BackendState, { readonly kind: 'connected' }> = {
        kind: 'connected',
        backend: this.backend.connection,
      }
      // A cached backend is still a connection result. Re-publish the state so
      // callers that subscribed after the original attach do not remain on a
      // stale failed/idle snapshot.
      this.publish(state)
      return { backend: this.backend, state }
    }

    if (request.mode === 'custom') {
      const endpoint = request.endpoint
      if (endpoint === undefined) {
        const error = new AppError({
          code: 'INVALID_CONFIGURATION',
          message: 'A custom DSH endpoint must be configured before connecting.',
          retryable: false,
        })
        this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
        throw error
      }
      let discovered: readonly BackendCandidate[] = []
      const needsDiscovery = isLoopbackEndpoint(endpoint) && !request.runtimeVersion?.trim()
      if (needsDiscovery) this.publish({ kind: 'discovering', attempt: 1, phase: 'discovery' })
      try {
        if (needsDiscovery) {
          discovered = await (this.dependencies.discovery.resolvePreferred?.(
            [{ endpoint, source: 'configured', confidence: 120 }],
            signal,
          ) ?? this.dependencies.discovery.discover(signal))
          this.throwIfAborted(signal)
          this.progress({ phase: 'discovery', status: 'succeeded', count: discovered.length })
        }
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled(error)
        this.progress({
          phase: 'discovery',
          status: 'failed',
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        })
        // Discovery is only an optional source of exact identity evidence for
        // this same endpoint; failure never redirects or blocks a custom probe.
      }
      const exactMatches = discovered.filter((candidate) => matchesCustomEndpoint(candidate, endpoint))
      // Composite discovery can preserve a configured or companion endpoint
      // as the winner while attaching identity proven by a current process
      // scan. Trust only the explicit manifest marker, never a source's raw
      // runtimeVersion or PID fields.
      const processCandidates = exactMatches.filter((candidate) => candidate.source === 'process-scan')
      const manifestCandidates = exactMatches.filter(
        (candidate) => candidate.runtimeVersionEvidence === 'process-manifest',
      )
      const verifiedManifestCandidates = manifestCandidates.filter(isVerifiedProcessManifestCandidate)
      const malformedManifest = verifiedManifestCandidates.length !== manifestCandidates.length
      const runtimeVersions = new Set(verifiedManifestCandidates.map((candidate) => candidate.runtimeVersion))
      const processPids = new Set(
        processCandidates.flatMap((candidate) =>
          candidate.pid !== undefined && Number.isSafeInteger(candidate.pid) && candidate.pid > 0
            ? [candidate.pid]
            : [],
        ),
      )
      const manifestPids = new Set(verifiedManifestCandidates.map((candidate) => candidate.pid))
      const pids = new Set([...processPids, ...manifestPids])
      const uniquePid = pids.size === 1 ? [...pids][0] : undefined
      const runtimeVersionIsBoundToUniquePid =
        uniquePid !== undefined &&
        verifiedManifestCandidates.length > 0 &&
        verifiedManifestCandidates.every((candidate) => candidate.pid === uniquePid)
      const hasVerifiedRuntimeIdentity =
        !malformedManifest &&
        runtimeVersions.size === 1 &&
        runtimeVersionIsBoundToUniquePid &&
        processCandidates.every(
          (candidate) =>
            candidate.pid !== undefined && Number.isSafeInteger(candidate.pid) && candidate.pid > 0,
        )
      // An explicit runtime-version override takes precedence over discovery:
      // a containerized DSH cannot expose a process manifest, so the only
      // evidence of its wire version is the user's configured value.
      const configuredRuntimeVersion =
        request.runtimeVersion !== undefined && request.runtimeVersion.trim() !== ''
          ? request.runtimeVersion.trim()
          : undefined
      const discoveredRuntimeVersion = [...runtimeVersions][0]
      const candidate: BackendCandidate = {
        endpoint,
        source: 'configured',
        confidence: 120,
        ...(configuredRuntimeVersion !== undefined
          ? { runtimeVersion: configuredRuntimeVersion }
          : hasVerifiedRuntimeIdentity && discoveredRuntimeVersion !== undefined
            ? {
                runtimeVersion: discoveredRuntimeVersion,
                runtimeVersionEvidence: 'process-manifest' as const,
              }
            : {}),
        ...(hasVerifiedRuntimeIdentity && uniquePid !== undefined ? { pid: uniquePid } : {}),
      }
      try {
        if (this.dependencies.endpointPreparation !== undefined) {
          this.publish({ kind: 'connecting', candidate, phase: 'authorization' })
          await this.dependencies.endpointPreparation.prepare(
            endpoint,
            signal ?? new AbortController().signal,
          )
          this.throwIfAborted(signal)
          this.progress({ phase: 'authorization', status: 'succeeded' })
        }
        this.throwIfAborted(signal)
        this.publish({ kind: 'connecting', candidate, phase: 'verification' })
        const verified = await this.dependencies.probe.probe(candidate, signal)
        this.throwIfAborted(signal)
        this.progress({
          phase: 'verification',
          status: verified === undefined ? 'failed' : 'succeeded',
          ...(verified === undefined ? {} : { hostVersion: verified.capabilities.dshVersion }),
        })
        if (verified !== undefined) return this.attach(verified, undefined, signal, generation)
      } catch (error) {
        await this.dependencies.endpointPreparation?.release?.(endpoint)
        if (isCancellation(error, signal)) throw cancelled(error)
        // The user explicitly selected this endpoint, so a definitive
        // DSH-incompatible classification from the probe chain must reach the
        // caller instead of degrading into a generic unreachable error.
        if (
          error instanceof AppError &&
          ['DSH_INCOMPATIBLE', 'AUTH_REQUIRED', 'PERMISSION_DENIED', 'INVALID_ENDPOINT'].includes(error.code)
        ) {
          this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
          throw error
        }
      }
      const error = new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The configured DSH endpoint did not respond as a compatible DSH service.',
        retryable: true,
      })
      await this.dependencies.endpointPreparation?.release?.(endpoint)
      this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      throw error
    }

    const attemptedEndpoints = new Set<string>()
    let recheckDiscoveryBeforeStart = false
    if (request.mode !== 'new-isolated') {
      this.publish({ kind: 'discovering', attempt: 1, phase: 'discovery' })
      let fastCandidates: readonly BackendCandidate[] | undefined
      if (this.dependencies.discovery.discoverFast !== undefined) {
        try {
          fastCandidates = restrictCandidates(
            await this.dependencies.discovery.discoverFast(signal),
            request.allowedEndpoints,
          )
          this.throwIfAborted(signal)
          this.progress({ phase: 'discovery-cache', status: 'succeeded', count: fastCandidates.length })
        } catch (error) {
          if (isCancellation(error, signal)) throw cancelled(error)
          // Fast discovery is an optimization. A stale registry or another
          // optional source must not prevent the authoritative full pass.
        }
        // Fast providers can locate endpoints but usually cannot prove which
        // DSH wire version owns them. Keep the fast path for candidates whose
        // adjacent package manifest was already verified; defer unversioned
        // candidates until the bounded process discovery pass has completed.
        for (const source of ['configured', 'known'] as const) {
          const preferred = (fastCandidates ?? []).filter((candidate) => candidate.source === source)
          if (preferred.length === 0) continue
          let resolved: readonly BackendCandidate[] = preferred
          try {
            resolved = (await this.dependencies.discovery.resolvePreferred?.(preferred, signal)) ?? preferred
            this.throwIfAborted(signal)
          } catch (error) {
            if (isCancellation(error, signal)) throw cancelled(error)
          }
          const fastResult = await this.tryCandidates(
            restrictCandidates(resolved, request.allowedEndpoints).filter(isVerifiedProcessManifestCandidate),
            signal,
            generation,
            attemptedEndpoints,
          )
          if (fastResult !== undefined) return fastResult
        }
        const fastResult = await this.tryCandidates(
          (fastCandidates ?? []).filter(
            (candidate) =>
              candidate.source !== 'configured' &&
              candidate.source !== 'known' &&
              isVerifiedProcessManifestCandidate(candidate),
          ),
          signal,
          generation,
          attemptedEndpoints,
        )
        if (fastResult !== undefined) return fastResult
      }

      let candidates: readonly BackendCandidate[]
      try {
        if (this.dependencies.discovery.discoverFast !== undefined)
          this.publish({ kind: 'discovering', attempt: 1, phase: 'discovery' })
        candidates =
          fastCandidates !== undefined && this.dependencies.discovery.discoverRemaining !== undefined
            ? await this.dependencies.discovery.discoverRemaining(fastCandidates, signal)
            : await this.dependencies.discovery.discover(signal)
        candidates = restrictCandidates(candidates, request.allowedEndpoints)
        this.throwIfAborted(signal)
        this.progress({ phase: 'discovery', status: 'succeeded', count: candidates.length })
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled(error)
        this.publish({
          kind: 'failed',
          message: error instanceof AppError ? error.message : 'The DSH instance discovery failed.',
          retryable: error instanceof AppError ? error.retryable : true,
        })
        throw error
      }
      const result = await this.tryDiscoveredCandidates(candidates, signal, generation, attemptedEndpoints)
      if (result !== undefined) return result
      recheckDiscoveryBeforeStart =
        candidates.length === 0 || this.dependencies.discovery.discoverFast !== undefined
    }

    if (request.mode === 'attach-only' || !request.autoStart || request.allowedEndpoints !== undefined) {
      const error = new AppError({
        code: 'NO_RUNNING_INSTANCE',
        message:
          request.allowedEndpoints === undefined
            ? 'No compatible local DSH instance is running.'
            : 'No compatible DSH service is available at the configured endpoints.',
        retryable: true,
      })
      this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      throw error
    }

    this.throwIfAborted(signal)
    this.publish({ kind: 'locating-runtime' })
    let runtimeLookup: RuntimeLookupResult
    try {
      runtimeLookup = await this.dependencies.runtimeLocator.locate(signal)
      this.throwIfAborted(signal)
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled(error)
      // A locate failure — a probe timeout, a selected executable that cannot
      // run — must reach a terminal state too. Without this the last published
      // snapshot stayed on 'locating-runtime' while the operation had already
      // rejected, and the Webview showed a loading skeleton that never ended.
      // The error itself keeps travelling unchanged so an unclassifiable one
      // still reaches the diagnostics channel.
      this.publish({
        kind: 'failed',
        message: error instanceof AppError ? error.message : 'The DSH runtime could not be located.',
        retryable: error instanceof AppError ? error.retryable : true,
      })
      throw error
    }
    const runtime = runtimeLookup.runtime
    if (runtime?.supported === true)
      this.progress({ phase: 'runtime', status: 'succeeded', hostVersion: runtime.version })
    if (runtime !== undefined && !runtime.supported) {
      this.publish({
        kind: 'failed',
        message: 'The selected executable did not report a DSH version.',
        retryable: false,
      })
      throw new AppError({
        code: 'DSH_INCOMPATIBLE',
        message: 'The selected executable did not report a valid DeepSeek Harness version.',
        retryable: false,
      })
    }
    if (runtime === undefined) {
      const searchedLocations = runtimeLookup.searchedLocations
      this.publish({ kind: 'runtime-missing', searchedLocations })
      throw new AppError({
        code: 'DSH_NOT_FOUND',
        message: 'DeepSeek Harness was not found. Install it or select an executable.',
        retryable: true,
        context: { searched: searchedLocations.length },
      })
    }

    // Re-read lightweight endpoint records immediately before launch, including
    // instances announced while locating the runtime. The full process pass
    // already completed; do not repeat expensive OS scans to narrow this race.
    if (recheckDiscoveryBeforeStart) {
      const discovery = this.dependencies.discovery
      const phase = discovery.discoverFast === undefined ? 'discovery' : 'discovery-cache'
      this.progress({ phase, status: 'started' })
      try {
        const lastChance = await (discovery.discoverFast?.(signal) ?? discovery.discover(signal))
        this.throwIfAborted(signal)
        this.progress({ phase, status: 'succeeded', count: lastChance.length })
        const result = await this.tryDiscoveredCandidates(lastChance, signal, generation, attemptedEndpoints)
        if (result !== undefined) return result
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled(error)
        this.publish({
          kind: 'failed',
          message: error instanceof AppError ? error.message : 'The DSH instance discovery failed.',
          retryable: error instanceof AppError ? error.retryable : true,
        })
        throw error
      }
    }

    this.publish({ kind: 'starting', runtime })
    let process: ManagedProcessHandle
    try {
      process = await this.dependencies.processSupervisor.start(runtime, signal)
    } catch (error) {
      if (isCancellation(error, signal)) throw cancelled(error)
      if (error instanceof AppError && error.code === 'PORT_CONFLICT') {
        const port = Number(error.context?.port ?? 0)
        this.publish({ kind: 'port-conflict', port, message: error.message, retryable: error.retryable })
      } else if (error instanceof AppError) {
        this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      } else {
        this.publish({
          kind: 'failed',
          message: 'The managed DSH process could not be started.',
          retryable: true,
        })
      }
      throw error
    }
    this.managedProcess = process
    try {
      this.throwIfAborted(signal)
      this.progress({ phase: 'process', status: 'succeeded', ownership: 'managed' })
      const candidate: BackendCandidate = {
        endpoint: process.endpoint,
        source: 'known',
        runtimeVersion: runtime.version,
        pid: process.pid,
        confidence: 100,
      }
      // The connect phase starts once this extension has a process to attach to.
      // Probing a discovered instance is still part of finding one, so it must
      // not publish `connecting` ahead of `locating-runtime`/`starting`.
      this.publish({ kind: 'connecting', candidate, phase: 'verification' })
      let verified: ConnectedBackend | undefined
      try {
        verified = await this.dependencies.probe.probe(candidate, signal)
        this.throwIfAborted(signal)
        if (verified !== undefined)
          this.progress({
            phase: 'verification',
            status: 'succeeded',
            hostVersion: verified.capabilities.dshVersion,
          })
      } catch (error) {
        if (isCancellation(error, signal)) throw cancelled(error)
        // Every terminal connect failure publishes a failed state before
        // throwing; without this the last snapshot would stay on 'starting'
        // while the operation already rejected.
        this.publish({
          kind: 'failed',
          message:
            error instanceof AppError
              ? error.message
              : 'The managed DSH process did not accept a connection.',
          retryable: error instanceof AppError ? error.retryable : true,
        })
        throw error
      }
      if (verified === undefined) {
        const error = new AppError({
          code: 'BACKEND_UNREACHABLE',
          message: 'The managed DSH process did not become ready.',
          retryable: true,
        })
        this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
        throw error
      }
      return this.attach({ ...verified, ownership: 'managed', pid: process.pid }, process, signal, generation)
    } catch (error) {
      if (this.managedProcess === process && this.backend === undefined) {
        try {
          await stopManagedProcess(process)
          if (this.managedProcess === process) this.managedProcess = undefined
        } catch (cleanupError) {
          const failure = new AppError({
            code: 'PROCESS_FAILED',
            message: 'The managed DSH process could not be stopped after a failed connection.',
            retryable: true,
            cause: new AggregateError([error, cleanupError]),
          })
          this.publish({ kind: 'failed', message: failure.message, retryable: failure.retryable })
          throw failure
        }
      }
      throw error
    }
  }

  private async tryCandidates(
    candidates: readonly BackendCandidate[],
    signal: AbortSignal | undefined,
    generation: number,
    attemptedEndpoints: Set<string>,
  ): Promise<ConnectionResult | undefined> {
    const pending = candidates.filter((candidate) => {
      const key = candidateEndpointKey(candidate)
      if (attemptedEndpoints.has(key)) return false
      attemptedEndpoints.add(key)
      return true
    })
    const firstAttempt = attemptedEndpoints.size - pending.length + 1
    const abort = new AbortController()
    const probeSignal = combineSignals(signal, abort.signal)
    // Probes only read identity and release their transports. Prefetch a small
    // window, but consume in rank order and attach exactly one backend.
    const probes = new Map<number, ReturnType<typeof probeCandidate>>()
    const enqueue = (index: number): void => {
      const candidate = pending[index]
      if (candidate !== undefined)
        probes.set(index, probeCandidate(this.dependencies.probe, candidate, probeSignal))
    }
    try {
      this.throwIfAborted(signal)
      for (let index = 0; index < Math.min(3, pending.length); index += 1) enqueue(index)
      for (const [index, candidate] of pending.entries()) {
        this.throwIfAborted(signal)
        const attempt = firstAttempt + index
        this.publish({ kind: 'discovering', attempt, phase: 'verification' })
        const outcome = await probes.get(index)
        probes.delete(index)
        this.throwIfAborted(signal)
        if (outcome === undefined) throw new Error('Missing DSH candidate probe.')
        if (outcome.kind === 'failed') {
          if (isCancellation(outcome.error, signal)) throw cancelled(outcome.error)
          this.progress({
            phase: 'verification',
            status: 'failed',
            attempt,
            candidateSource: candidate.source,
            code: outcome.error instanceof AppError ? outcome.error.code : 'INTERNAL_ERROR',
          })
          enqueue(index + 3)
          continue
        }
        const verified = outcome.backend
        this.progress({
          phase: 'verification',
          status: verified === undefined ? 'unavailable' : 'succeeded',
          attempt,
          candidateSource: candidate.source,
          ...(verified === undefined ? {} : { hostVersion: verified.capabilities.dshVersion }),
        })
        if (verified !== undefined) return this.attach(verified, undefined, signal, generation)
        enqueue(index + 3)
      }
      return undefined
    } finally {
      abort.abort()
    }
  }

  private async tryDiscoveredCandidates(
    candidates: readonly BackendCandidate[],
    signal: AbortSignal | undefined,
    generation: number,
    attemptedEndpoints: Set<string>,
  ): Promise<ConnectionResult | undefined> {
    for (const sources of [
      ['configured'],
      ['known'],
      ['companion', 'process-scan', 'default-port'],
    ] as const) {
      const group = candidates.filter((candidate) =>
        (sources as readonly string[]).includes(candidate.source),
      )
      const exactCandidates = group.filter(isVerifiedProcessManifestCandidate)
      const exactEndpoints = new Set(exactCandidates.map(candidateEndpointKey))
      const candidatesWithoutExactIdentity = group.filter(
        (candidate) =>
          candidate.runtimeVersionEvidence !== 'process-manifest' &&
          !exactEndpoints.has(candidateEndpointKey(candidate)),
      )
      const exactResult = await this.tryCandidates(exactCandidates, signal, generation, attemptedEndpoints)
      if (exactResult !== undefined) return exactResult
      const result = await this.tryCandidates(
        candidatesWithoutExactIdentity,
        signal,
        generation,
        attemptedEndpoints,
      )
      if (result !== undefined) return result
    }
    return undefined
  }

  private async attach(
    connected: DshBackend['connection'],
    managed: ManagedProcessHandle | undefined,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<ConnectionResult> {
    this.throwIfAborted(signal)
    if (generation !== this.generation) throw cancelled(signal?.reason)
    this.publish({
      kind: 'connecting',
      candidate: { endpoint: connected.endpoint, source: 'known', confidence: 100 },
      phase: 'initialization',
    })
    const identifiedConnection: DshBackend['connection'] = {
      ...connected,
      // This opaque identity is scoped to this coordinator lifetime. It is
      // deliberately not derived from the local endpoint or process command.
      backendInstanceId: connected.backendInstanceId ?? `backend-${generation}`,
      connectionGeneration: generation,
    }
    let backend: DshBackend
    try {
      backend = await this.dependencies.backendFactory.connect(identifiedConnection, signal)
    } catch (error) {
      if (generation === this.generation && !isCancellation(error, signal))
        this.publish({
          kind: 'failed',
          message: error instanceof AppError ? error.message : 'The DSH connection could not be established.',
          retryable: error instanceof AppError ? error.retryable : true,
        })
      throw error
    }
    if (generation !== this.generation || signal?.aborted === true) {
      const cleanupFailures: unknown[] = []
      try {
        await backend.close()
      } catch (error) {
        this.orphanedBackends.add(backend)
        cleanupFailures.push(error)
      }
      if (cleanupFailures.length > 0) {
        const failure = new AppError({
          code: 'PROCESS_FAILED',
          message: 'A stale DSH connection could not be fully closed.',
          retryable: true,
          cause: new AggregateError(cleanupFailures),
        })
        if (generation === this.generation)
          this.publish({ kind: 'failed', message: failure.message, retryable: failure.retryable })
        throw failure
      }
      throw cancelled(signal?.reason)
    }
    this.backend = backend
    this.progress({ phase: 'initialization', status: 'succeeded' })
    if (managed === undefined) this.managedProcess = undefined
    const state: Extract<BackendState, { readonly kind: 'connected' }> = {
      kind: 'connected',
      backend: identifiedConnection,
    }
    this.publish(state)
    return { backend, state }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw cancelled(signal.reason)
  }

  private publish(state: BackendState): void {
    const previous = this.state
    this.state = state
    if (state.kind === 'discovering')
      this.progress({
        phase: state.phase ?? 'discovery',
        status: 'started',
        ...(state.phase === 'verification' ? { attempt: state.attempt } : {}),
      })
    else if (state.kind === 'connecting')
      this.progress({
        phase: state.phase ?? 'verification',
        status: 'started',
        ...(state.phase === 'verification' ? { candidateSource: state.candidate.source } : {}),
      })
    else if (state.kind === 'locating-runtime') this.progress({ phase: 'runtime', status: 'started' })
    else if (state.kind === 'starting')
      this.progress({ phase: 'process', status: 'started', hostVersion: state.runtime.version })
    else if (
      state.kind === 'connected' &&
      (previous.kind !== 'connected' || previous.backend !== state.backend)
    )
      this.progress({
        phase: 'connect',
        status: 'succeeded',
        hostVersion: state.backend.capabilities.dshVersion,
        ownership: state.backend.ownership,
      })
    else if (state.kind === 'stopping')
      this.progress({ phase: 'disconnect', status: 'started', ownership: state.ownership })
    else if (state.kind === 'idle' && previous.kind === 'stopping')
      this.progress({ phase: 'disconnect', status: 'succeeded' })
    for (const listener of this.listeners) listener(state)
  }

  private progress(progress: ConnectionProgress): void {
    try {
      this.dependencies.onProgress?.(progress)
    } catch {
      // A diagnostic observer cannot change connection or process ownership.
    }
  }
}

async function probeCandidate(
  probe: BackendProbe,
  candidate: BackendCandidate,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'verified'; readonly backend: ConnectedBackend | undefined }
  | { readonly kind: 'failed'; readonly error: unknown }
> {
  try {
    return { kind: 'verified', backend: await probe.probe(candidate, signal) }
  } catch (error) {
    return { kind: 'failed', error }
  }
}

function combineSignals(first: AbortSignal | undefined, second: AbortSignal): AbortSignal {
  if (first === undefined) return second
  return AbortSignal.any([first, second])
}

function sameRequest(left: ConnectionRequest | undefined, right: ConnectionRequest): boolean {
  return (
    left?.mode === right.mode &&
    left.autoStart === right.autoStart &&
    left.runtimeVersion === right.runtimeVersion &&
    left.credentialRevision === right.credentialRevision &&
    left.allowedEndpoints?.map((endpoint) => endpoint.baseUrl).join('\0') ===
      right.allowedEndpoints?.map((endpoint) => endpoint.baseUrl).join('\0') &&
    left.endpoint?.baseUrl === right.endpoint?.baseUrl
  )
}

function restrictCandidates(
  candidates: readonly BackendCandidate[],
  allowed: readonly BackendEndpoint[] | undefined,
): readonly BackendCandidate[] {
  return allowed === undefined
    ? candidates
    : candidates.filter((candidate) =>
        allowed.some((endpoint) => endpoint.baseUrl === candidate.endpoint.baseUrl),
      )
}

function matchesCustomEndpoint(candidate: BackendCandidate, selected: BackendEndpoint): boolean {
  const discovered = candidate.endpoint
  if (!isCanonicalEndpoint(discovered) || !isCanonicalEndpoint(selected)) return false
  if (!isLoopbackEndpoint(discovered) || !isLoopbackEndpoint(selected)) return false
  if (discovered.port !== selected.port) return false
  if (discovered.host === selected.host) return discovered.baseUrl === selected.baseUrl
  return (
    isLoopbackEndpoint(discovered) &&
    isLoopbackEndpoint(selected) &&
    candidate.pid !== undefined &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    candidate.commandLine !== undefined &&
    candidate.commandLine.trim() !== ''
  )
}

function candidateEndpointKey(candidate: BackendCandidate): string {
  return `${candidate.endpoint.host}:${candidate.endpoint.port}`
}

function isDshRuntimeVersion(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  )
}

function isVerifiedProcessManifestCandidate(candidate: BackendCandidate): candidate is BackendCandidate & {
  readonly runtimeVersion: string
  readonly runtimeVersionEvidence: 'process-manifest'
  readonly pid: number
  readonly commandLine: string
} {
  return (
    candidate.runtimeVersionEvidence === 'process-manifest' &&
    candidate.runtimeVersion !== undefined &&
    isDshRuntimeVersion(candidate.runtimeVersion) &&
    candidate.pid !== undefined &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    candidate.commandLine !== undefined &&
    candidate.commandLine.trim() !== ''
  )
}

function shouldDisconnectForRequest(current: BackendEndpoint, request: ConnectionRequest): boolean {
  return (
    request.mode === 'new-isolated' ||
    (request.mode === 'custom' && request.endpoint?.baseUrl !== current.baseUrl)
  )
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted)
    return Promise.resolve().then(() => {
      throw cancelled(signal.reason)
    })
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(cancelled(signal.reason))
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error instanceof Error ? error : new Error('The DSH connection failed.'))
      },
    )
  })
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return isAbort(error, signal) || (error instanceof AppError && error.code === 'REQUEST_CANCELLED')
}

function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'The DSH operation was cancelled.',
    retryable: true,
    cause,
  })
}

async function stopManagedProcess(process: ManagedProcessHandle): Promise<void> {
  try {
    await process.stop()
  } catch (cause) {
    throw new AppError({
      code: 'PROCESS_FAILED',
      message: 'The managed DSH process could not be stopped.',
      retryable: true,
      cause,
    })
  }
}
