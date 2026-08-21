import {
  AppError,
  type BackendCandidate,
  type BackendEndpoint,
  type BackendState,
  type DshBackend,
  type ManagedProcessHandle,
} from '@dsh-vscode/domain'

import type {
  BackendDiscovery,
  BackendFactory,
  BackendProbe,
  ConnectionRequest,
  ProcessSupervisor,
  RuntimeLocator,
} from './ports.js'

export interface ConnectionCoordinatorDependencies {
  readonly runtimeLocator: RuntimeLocator
  readonly discovery: BackendDiscovery
  readonly probe: BackendProbe
  readonly backendFactory: BackendFactory
  readonly processSupervisor: ProcessSupervisor
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
  private managedProcess: ManagedProcessHandle | undefined
  private operationAbort: AbortController | undefined
  private disconnectOperation: Promise<void> | undefined
  private generation = 0

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
    if (this.disconnectOperation !== undefined) await this.disconnectOperation
    if (this.inFlight !== undefined) {
      if (!sameRequest(this.inFlightRequest, request))
        throw new AppError({
          code: 'BACKEND_BUSY',
          message: 'Another DSH connection operation is already in progress.',
          retryable: true,
        })
      return waitForSignal(this.inFlight, signal)
    }
    if (this.backend !== undefined && shouldDisconnectForRequest(this.backend.connection.endpoint, request))
      await this.disconnect()
    const generation = ++this.generation
    const operationAbort = new AbortController()
    this.operationAbort = operationAbort
    const operationSignal = combineSignals(signal, operationAbort.signal)
    const operation = this.connectOnce(request, operationSignal, generation)
    this.inFlight = operation
    this.inFlightRequest = request
    void operation.then(
      () => {
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

  public async disconnect(): Promise<void> {
    if (this.disconnectOperation !== undefined) return this.disconnectOperation
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
    const managed = this.managedProcess
    this.backend = undefined
    this.managedProcess = undefined
    this.publish({ kind: 'stopping', ownership: managed === undefined ? 'external' : 'managed' })
    let closeError: unknown
    let stopError: unknown
    try {
      await backend?.close()
    } catch (error) {
      closeError = error
    }
    if (managed !== undefined) {
      try {
        await managed.stop()
      } catch (error) {
        stopError = error
      }
    }
    if (closeError !== undefined || stopError !== undefined) {
      this.publish({
        kind: 'failed',
        message: 'The DSH connection could not be closed cleanly.',
        retryable: true,
      })
      throw closeError ?? stopError
    }
    if (closeError === undefined && stopError === undefined) {
      this.publish({ kind: 'idle' })
    }
  }

  private async connectOnce(
    request: ConnectionRequest,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<ConnectionResult> {
    if (
      this.backend !== undefined &&
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
    this.throwIfAborted(signal)

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
      const candidate: BackendCandidate = {
        endpoint,
        source: 'configured',
        confidence: 120,
      }
      this.publish({ kind: 'connecting', candidate })
      try {
        const verified = await this.dependencies.probe.probe(candidate, signal)
        if (verified !== undefined) return this.attach(verified, undefined, signal, generation)
      } catch (error) {
        if (isAbort(error, signal)) throw cancelled(error)
      }
      const error = new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The configured DSH endpoint did not respond as a compatible local DSH service.',
        retryable: true,
      })
      this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      throw error
    }

    if (request.mode !== 'new-isolated') {
      this.publish({ kind: 'discovering', attempt: 1 })
      const candidates = await this.dependencies.discovery.discover(signal)
      for (const candidate of candidates) {
        this.throwIfAborted(signal)
        this.publish({ kind: 'connecting', candidate })
        try {
          const verified = await this.dependencies.probe.probe(candidate, signal)
          if (verified !== undefined) return this.attach(verified, undefined, signal, generation)
        } catch (error) {
          if (isAbort(error, signal)) throw cancelled(error)
          // A bad candidate must not prevent a later, higher-confidence candidate
          // from being tried. The probe owns the detailed redacted diagnostics.
        }
      }
      // Close the small race where another DSH appears while the first pass
      // is finishing. Only an empty first pass gets one bounded last chance;
      // failed candidates have already been fully probed.
      if (candidates.length === 0 && request.autoStart) {
        const lastChance = await this.dependencies.discovery.discover(signal)
        for (const candidate of lastChance) {
          this.throwIfAborted(signal)
          this.publish({ kind: 'connecting', candidate })
          try {
            const verified = await this.dependencies.probe.probe(candidate, signal)
            if (verified !== undefined) return this.attach(verified, undefined, signal, generation)
          } catch (error) {
            if (isAbort(error, signal)) throw cancelled(error)
          }
        }
      }
    }

    if (request.mode === 'attach-only' || !request.autoStart) {
      const error = new AppError({
        code: 'NO_RUNNING_INSTANCE',
        message: 'No compatible local DSH instance is running.',
        retryable: true,
      })
      this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      throw error
    }

    this.throwIfAborted(signal)
    this.publish({ kind: 'locating-runtime' })
    const runtime = await this.dependencies.runtimeLocator.locate(signal)
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
      const searchedLocations = this.dependencies.runtimeLocator.searchedLocations()
      this.publish({ kind: 'runtime-missing', searchedLocations })
      throw new AppError({
        code: 'DSH_NOT_FOUND',
        message: 'DeepSeek Harness was not found. Install it or select an executable.',
        retryable: true,
        context: { searched: searchedLocations.length },
      })
    }

    this.publish({ kind: 'starting', runtime })
    let process: ManagedProcessHandle
    try {
      process = await this.dependencies.processSupervisor.start(runtime, signal)
    } catch (error) {
      if (error instanceof AppError && error.code === 'PORT_CONFLICT') {
        const port = Number(error.context?.port ?? 0)
        this.publish({ kind: 'port-conflict', port, message: error.message, retryable: error.retryable })
      } else if (error instanceof AppError) {
        this.publish({ kind: 'failed', message: error.message, retryable: error.retryable })
      }
      throw error
    }
    this.managedProcess = process
    try {
      const candidate: BackendCandidate = {
        endpoint: process.endpoint,
        source: 'known',
        runtimeVersion: runtime.version,
        pid: process.pid,
        confidence: 100,
      }
      const verified = await this.dependencies.probe.probe(candidate, signal)
      if (verified === undefined) {
        await stopManagedProcess(process)
        this.managedProcess = undefined
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
        await stopManagedProcess(process).catch(() => undefined)
        this.managedProcess = undefined
      }
      throw error
    }
  }

  private async attach(
    connected: DshBackend['connection'],
    managed: ManagedProcessHandle | undefined,
    signal: AbortSignal | undefined,
    generation: number,
  ): Promise<ConnectionResult> {
    const backend = await this.dependencies.backendFactory.connect(connected)
    if (generation !== this.generation || signal?.aborted === true) {
      await backend.close().catch(() => undefined)
      if (managed !== undefined) await managed.stop().catch(() => undefined)
      throw cancelled(signal?.reason)
    }
    this.backend = backend
    if (managed === undefined) this.managedProcess = undefined
    const state: Extract<BackendState, { readonly kind: 'connected' }> = {
      kind: 'connected',
      backend: connected,
    }
    this.publish(state)
    return { backend, state }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) throw cancelled(signal.reason)
  }

  private publish(state: BackendState): void {
    this.state = state
    for (const listener of this.listeners) listener(state)
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
    left.endpoint?.baseUrl === right.endpoint?.baseUrl
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
