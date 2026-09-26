import type { ProcessSupervisor } from '@dsh-vscode/application'
import { isKnownDshAlphaVersion, managedWebArguments } from '@dsh-vscode/dsh-adapter'
import {
  AppError,
  type BackendEndpoint,
  type DshRuntime,
  type ManagedProcessHandle,
  type ToolMode,
} from '@dsh-vscode/domain'

export interface SpawnedChild {
  readonly pid: number
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  readonly kill: (signal?: NodeJS.Signals) => void
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export interface ProcessSupervisorDependencies {
  readonly spawn: (
    executable: string,
    args: readonly string[],
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ) => SpawnedChild
  readonly managedPort: () => number
  readonly workingDirectory?: () => string | undefined
  readonly toolMode?: () => ToolMode | undefined
  /** Complete the managed alpha web login before exposing the endpoint. */
  readonly onReadyEndpoint?: (
    endpoint: BackendEndpoint,
    launchUrl: string | undefined,
    signal: AbortSignal,
  ) => Promise<void> | void
}

interface ReadyEndpoint {
  readonly endpoint: BackendEndpoint
  readonly launchUrl?: string
}

const startupStepTimeoutMs = 15_000

export class DshProcessSupervisor implements ProcessSupervisor {
  private active: ManagedProcessHandle | undefined
  private starting: Promise<ManagedProcessHandle> | undefined
  private startupController: AbortController | undefined
  private disposing: Promise<void> | undefined
  private disposeRequested = false
  private readonly failedStops = new Set<ManagedProcessHandle>()
  private failedStartupChild: SpawnedChild | undefined

  public constructor(private readonly dependencies: ProcessSupervisorDependencies) {}

  public start(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle> {
    if (this.disposeRequested)
      return Promise.reject(
        new AppError({
          code: 'PROCESS_FAILED',
          message: 'The managed DSH process supervisor is shutting down.',
          retryable: false,
        }),
      )
    if (this.active !== undefined) return Promise.resolve(this.active)
    if (this.starting !== undefined) return this.starting
    const startupController = new AbortController()
    const abortStartup = (): void => startupController.abort(signal?.reason)
    if (signal?.aborted === true) abortStartup()
    else signal?.addEventListener('abort', abortStartup, { once: true })
    this.startupController = startupController
    const operation = this.startOnce(runtime, startupController)
    this.starting = operation
    const clearStartup = (): void => {
      signal?.removeEventListener('abort', abortStartup)
      if (this.starting !== operation) return
      this.starting = undefined
      if (this.startupController === startupController) this.startupController = undefined
    }
    void operation.then(clearStartup, clearStartup)
    return operation
  }

  /** Retry cleanup for children this supervisor still owns after a failed start or stop. */
  public dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing
    this.disposeRequested = true
    this.startupController?.abort()
    const operation = this.disposeOnce()
    this.disposing = operation
    void operation.then(
      () => {
        if (this.disposing === operation) this.disposing = undefined
      },
      () => {
        if (this.disposing === operation) this.disposing = undefined
      },
    )
    return operation
  }

  private async disposeOnce(): Promise<void> {
    await this.starting?.catch(() => undefined)
    const ownedHandles = new Set(this.failedStops)
    const active = this.active
    if (active !== undefined) ownedHandles.add(active)
    const failures: unknown[] = []
    for (const handle of ownedHandles) {
      try {
        await handle.stop()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      await this.retryFailedStartupCleanup()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length > 0)
      throw new AppError({
        code: 'PROCESS_FAILED',
        message: 'The managed DSH process could not be fully shut down.',
        retryable: true,
        cause: failures.length === 1 ? failures[0] : new AggregateError(failures),
      })
  }

  private async startOnce(
    runtime: DshRuntime,
    startupController: AbortController,
  ): Promise<ManagedProcessHandle> {
    const { signal } = startupController
    throwIfCancelled(signal)
    await this.retryFailedStops()
    this.throwIfDisposing()
    await this.retryFailedStartupCleanup()
    this.throwIfDisposing()
    throwIfCancelled(signal)
    const configuredPort = this.dependencies.managedPort()
    const port =
      Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535 ? configuredPort : 0
    let child: SpawnedChild
    try {
      child = this.dependencies.spawn(
        runtime.executable,
        managedWebArguments(runtime.version, port),
        this.dependencies.workingDirectory?.(),
        toolEnvironment(this.dependencies.toolMode?.(), runtime.version),
      )
    } catch (error) {
      // `shell: false` rejects a shim target (`.cmd`/`.bat`) synchronously with
      // EINVAL, before any child exists.
      throw launchFailure(error)
    }
    if (child.pid <= 0) {
      // A launch that never produced a process writes no output and never
      // exits, so waiting for readiness would blame the runtime for a spawn
      // that failed outright (a missing or unusable executable).
      throw launchFailure()
    }
    const output = new RingBuffer(64 * 1024)
    const errors = new RingBuffer(64 * 1024)
    let resolvedEndpoint: ReadyEndpoint | undefined
    let readinessBuffer = ''
    let resolveReady: ((endpoint: ReadyEndpoint) => void) | undefined
    let rejectReady: ((reason: unknown) => void) | undefined
    const ready = new Promise<ReadyEndpoint>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const consume = async (
      source: AsyncIterable<string>,
      buffer: RingBuffer,
      isStdout: boolean,
    ): Promise<void> => {
      try {
        for await (const chunk of source) {
          buffer.append(chunk)
          if (!isStdout || resolvedEndpoint !== undefined) continue
          readinessBuffer = `${readinessBuffer}${chunk}`.slice(-32 * 1024)
          const lines = readinessBuffer.split(/\r?\n/)
          readinessBuffer = lines.pop() ?? ''
          for (const line of lines) {
            const endpoint = parseReadyEndpoint(line)
            if (endpoint !== undefined) {
              resolvedEndpoint = endpoint
              resolveReady?.(endpoint)
              break
            }
          }
          if (resolvedEndpoint === undefined) {
            const endpoint = parseReadyEndpoint(readinessBuffer)
            if (endpoint !== undefined) {
              resolvedEndpoint = endpoint
              resolveReady?.(endpoint)
            }
          }
        }
      } catch (error) {
        if (resolvedEndpoint === undefined) rejectReady?.(error)
      }
    }
    void consume(child.stdout, output, true)
    void consume(child.stderr, errors, false)
    const exited = child.exited.then((status) => {
      if (resolvedEndpoint === undefined) {
        rejectReady?.(
          new AppError({
            code: 'PROCESS_FAILED',
            message: 'The DSH process exited before it was ready.',
            retryable: true,
            context: { exitCode: status.code ?? -1 },
          }),
        )
      }
      return status
    })
    try {
      const readyEndpoint = await withTimeout(ready, startupStepTimeoutMs, signal)
      await awaitWithAbort(
        Promise.resolve(
          this.dependencies.onReadyEndpoint?.(readyEndpoint.endpoint, readyEndpoint.launchUrl, signal),
        ),
        startupController,
        startupStepTimeoutMs,
      )
      throwIfCancelled(signal)
      this.throwIfDisposing()
      let stopped = false
      let stopping: Promise<void> | undefined
      const handle: ManagedProcessHandle = {
        pid: child.pid,
        endpoint: readyEndpoint.endpoint,
        stop: () => {
          if (stopping !== undefined) return stopping
          if (stopped) return Promise.resolve()
          stopped = true
          if (this.active === handle) this.active = undefined
          // Track an in-progress stop too: start() and dispose() must wait for
          // this exact operation instead of mistaking the handle for released.
          this.failedStops.add(handle)
          const operation = Promise.resolve()
            .then(() => stopChild(child))
            .then(
              () => {
                this.failedStops.delete(handle)
              },
              (error: unknown) => {
                // Keep failed ownership retryable after a transient kill or
                // timeout, while every concurrent caller observes this error.
                stopped = false
                this.failedStops.add(handle)
                throw error
              },
            )
          stopping = operation
          void operation.then(
            () => {
              if (stopping === operation) stopping = undefined
            },
            () => {
              if (stopping === operation) stopping = undefined
            },
          )
          return operation
        },
      }
      this.active = handle
      void exited.then(() => {
        if (this.active?.pid === child.pid) this.active = undefined
        this.failedStops.delete(handle)
      })
      return handle
    } catch (error) {
      try {
        await stopChild(child)
      } catch (cleanupError) {
        this.failedStartupChild = child
        throw new AppError({
          code: 'PROCESS_FAILED',
          message: 'The DSH process failed to start and could not be stopped.',
          retryable: true,
          cause: new AggregateError([error, cleanupError]),
        })
      }
      const outputTail = errors.tail(160) || output.tail(160)
      if (/eaddrinuse|address already in use|port is already in use/i.test(outputTail))
        throw new AppError({
          code: 'PORT_CONFLICT',
          message: 'The configured DSH port is already in use.',
          retryable: true,
          context: { port },
        })
      if (error instanceof AppError) throw error
      throw new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'The DSH process did not report a loopback endpoint.',
        retryable: true,
        cause: error,
      })
    }
  }

  private async retryFailedStartupCleanup(): Promise<void> {
    const child = this.failedStartupChild
    if (child === undefined) return
    try {
      await stopChild(child)
    } catch (cause) {
      throw new AppError({
        code: 'PROCESS_FAILED',
        message: 'A previous DSH startup process could not be stopped.',
        retryable: true,
        cause,
      })
    }
    if (this.failedStartupChild === child) this.failedStartupChild = undefined
  }

  private async retryFailedStops(): Promise<void> {
    for (const handle of this.failedStops) await handle.stop()
  }

  private throwIfDisposing(): void {
    if (!this.disposeRequested) return
    throw new AppError({
      code: 'PROCESS_FAILED',
      message: 'The managed DSH process supervisor is shutting down.',
      retryable: false,
    })
  }
}

function parseReadyEndpoint(value: string): ReadyEndpoint | undefined {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const normalized = value.replace(ansiEscape, '')
  const match = normalized.match(
    /(?:dsh\s+web|listening|running)[^\r\n]*?(https?:\/\/(127\.0\.0\.1|localhost):(\d{1,5})(?:\/[^\s"'<>]*)?)/i,
  )
  const host = match?.[2]
  const port = Number(match?.[3])
  if (host !== '127.0.0.1' && host !== 'localhost') return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const endpoint: BackendEndpoint = { host, port, baseUrl: `http://${host}:${port}` }
  const rawUrl = match?.[1]?.replace(/[),.;]+$/u, '')
  if (rawUrl === undefined) return { endpoint }
  try {
    const launch = new URL(rawUrl)
    if (
      launch.pathname !== '/' ||
      launch.hash !== '' ||
      launch.hostname !== host ||
      Number(launch.port || (launch.protocol === 'https:' ? 443 : 80)) !== port ||
      launch.searchParams.get('token') === null ||
      launch.searchParams.get('token')?.trim() === ''
    )
      return { endpoint }
    return { endpoint, launchUrl: launch.href }
  } catch {
    return { endpoint }
  }
}

class RingBuffer {
  private value = ''
  public constructor(private readonly limit: number) {}
  public append(chunk: string): void {
    this.value = `${this.value}${chunk}`
    if (this.value.length > this.limit) this.value = this.value.slice(-this.limit)
  }
  public tail(limit: number): string {
    return this.value.slice(-limit).replace(/[\r\n]+/g, ' ')
  }
}

function launchFailure(cause?: unknown): AppError {
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'The DSH process could not be started.',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  })
}

async function stopChild(child: SpawnedChild): Promise<void> {
  child.kill('SIGTERM')
  const first = await waitForExit(child.exited, 2_000)
  if (first) return
  child.kill('SIGKILL')
  const second = await waitForExit(child.exited, 2_000)
  if (!second)
    throw new AppError({
      code: 'PROCESS_FAILED',
      message: 'The managed DSH process did not exit after termination was requested.',
      retryable: true,
    })
}

function waitForExit(exited: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      resolve(false)
    }, timeoutMs)
    exited.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(
          error instanceof Error
            ? error
            : new AppError({
                code: 'PROCESS_FAILED',
                message: 'Could not observe the managed DSH process exit.',
                retryable: true,
                cause: error,
              }),
        )
      },
    )
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new AppError({
            code: 'BACKEND_UNREACHABLE',
            message: 'Timed out waiting for DSH readiness.',
            retryable: true,
          }),
        ),
      timeoutMs,
    )
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(value as T)
      else reject(error instanceof Error ? error : new Error('DSH startup failed.'))
    }
    const onAbort = (): void => finish(undefined, cancelled(signal?.reason))
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      (error: unknown) => finish(undefined, error),
    )
  })
}

function awaitWithAbort<T>(promise: Promise<T>, controller: AbortController, timeoutMs: number): Promise<T> {
  const { signal } = controller
  if (signal.aborted) return Promise.reject(cancelled(signal.reason))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      const error = new AppError({
        code: 'BACKEND_UNREACHABLE',
        message: 'Timed out completing managed DSH endpoint initialization.',
        retryable: true,
      })
      finish(undefined, error)
      controller.abort(error)
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(value as T)
      else reject(error instanceof Error ? error : new Error('DSH startup failed.'))
    }
    const onAbort = (): void => finish(undefined, cancelled(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => finish(value),
      (error: unknown) => finish(undefined, error),
    )
  })
}

function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'DSH startup was cancelled.',
    retryable: true,
    cause,
  })
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw cancelled(signal.reason)
}

function toolEnvironment(mode: ToolMode | undefined, runtimeVersion: string): NodeJS.ProcessEnv | undefined {
  if (mode === undefined) return undefined
  const alpha = isKnownDshAlphaVersion(runtimeVersion)
  const wireMode = mode === 'code' || mode === 'ptc' ? (alpha ? 'ptc' : 'code') : mode
  return { ...process.env, DSH_TOOLS_MODE: wireMode }
}
