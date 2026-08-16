import type { ProcessSupervisor } from '@dsh-vscode/application'
import {
  AppError,
  type BackendEndpoint,
  type DshRuntime,
  type ManagedProcessHandle,
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
  readonly toolMode?: () => 'native' | 'code' | 'both' | undefined
}

export class DshProcessSupervisor implements ProcessSupervisor {
  private active: ManagedProcessHandle | undefined
  private starting: Promise<ManagedProcessHandle> | undefined

  public constructor(private readonly dependencies: ProcessSupervisorDependencies) {}

  public start(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle> {
    if (this.active !== undefined) return Promise.resolve(this.active)
    if (this.starting !== undefined) return this.starting
    const operation = this.startOnce(runtime, signal)
    this.starting = operation
    void operation.then(
      () => {
        if (this.starting === operation) this.starting = undefined
      },
      () => {
        if (this.starting === operation) this.starting = undefined
      },
    )
    return operation
  }

  private async startOnce(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle> {
    if (signal?.aborted === true) throw cancelled(signal.reason)
    const configuredPort = this.dependencies.managedPort()
    const port =
      Number.isInteger(configuredPort) && configuredPort >= 0 && configuredPort <= 65535 ? configuredPort : 0
    const child = this.dependencies.spawn(
      runtime.executable,
      ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port)],
      this.dependencies.workingDirectory?.(),
      toolEnvironment(this.dependencies.toolMode?.()),
    )
    const output = new RingBuffer(64 * 1024)
    const errors = new RingBuffer(64 * 1024)
    let resolvedEndpoint: BackendEndpoint | undefined
    let readinessBuffer = ''
    let resolveReady: ((endpoint: BackendEndpoint) => void) | undefined
    let rejectReady: ((reason: unknown) => void) | undefined
    const ready = new Promise<BackendEndpoint>((resolve, reject) => {
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
      const endpoint = await withTimeout(ready, 15_000, signal)
      const stopped = { value: false }
      const handle: ManagedProcessHandle = {
        pid: child.pid,
        endpoint,
        stop: async () => {
          if (stopped.value) return
          stopped.value = true
          await stopChild(child)
          if (this.active?.pid === child.pid) this.active = undefined
        },
      }
      this.active = handle
      void exited.then(() => {
        if (this.active?.pid === child.pid) this.active = undefined
      })
      return handle
    } catch (error) {
      await stopChild(child).catch(() => undefined)
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
}

function parseReadyEndpoint(value: string): BackendEndpoint | undefined {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const normalized = value.replace(ansiEscape, '')
  const match = normalized.match(
    /(?:dsh\s+web|listening|running)[^\r\n]*https?:\/\/(127\.0\.0\.1|localhost):(\d{1,5})/i,
  )
  const host = match?.[1]
  const port = Number(match?.[2])
  if (host !== '127.0.0.1' && host !== 'localhost') return undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port, baseUrl: `http://${host}:${port}` }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stopChild(child: SpawnedChild): Promise<void> {
  child.kill('SIGTERM')
  const first = await Promise.race([child.exited.then(() => true), delay(2_000).then(() => false)])
  if (first) return
  child.kill('SIGKILL')
  const second = await Promise.race([child.exited.then(() => true), delay(2_000).then(() => false)])
  if (!second)
    throw new AppError({
      code: 'PROCESS_FAILED',
      message: 'The managed DSH process did not exit after termination was requested.',
      retryable: true,
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

function cancelled(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'DSH startup was cancelled.',
    retryable: true,
    cause,
  })
}

function toolEnvironment(mode: 'native' | 'code' | 'both' | undefined): NodeJS.ProcessEnv | undefined {
  if (mode === undefined) return undefined
  return { ...process.env, DSH_TOOLS_MODE: mode }
}
