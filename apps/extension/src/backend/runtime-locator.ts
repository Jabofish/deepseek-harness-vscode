import type { RuntimeLocator, RuntimeLookupResult } from '@dsh-vscode/application'
import type { DshRuntime, OperatingSystem } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import { isKnownDshVersion } from '@dsh-vscode/dsh-adapter'
import path from 'node:path'

export interface RuntimeLocatorDependencies {
  readonly os: OperatingSystem
  readonly configuredPath: () => string | undefined
  readonly pathEntries: () => readonly string[]
  readonly npmGlobalPrefix: (signal?: AbortSignal) => Promise<string | undefined>
  readonly fileExists: (path: string) => Promise<boolean>
  readonly executeVersion: (executable: string, signal?: AbortSignal) => Promise<string>
  /**
   * Last executable path that produced a supported runtime, persisted by the
   * host across sessions. It only skips the candidate scan; a fresh version
   * probe still runs against it, so an upgraded global install keeps
   * reporting its new version.
   */
  readonly lastKnownRuntimePath?: () => RuntimePathHint | undefined
  readonly rememberRuntimePath?: (hint: RuntimePathHint) => void
}

export interface RuntimePathHint {
  readonly path: string
  readonly source: Exclude<DshRuntime['source'], 'configured' | 'bundled'>
}

export class DshRuntimeLocator implements RuntimeLocator {
  private cached: RuntimeLookupResult | undefined

  public constructor(private readonly dependencies: RuntimeLocatorDependencies) {}

  /**
   * Forget the memoized lookup result. The host must call this after anything
   * that can move or replace the executable: a runtime setting change, a
   * global reinstall, or a version switch. Failed and unsupported lookups are
   * never memoized, so a missing runtime keeps rescanning until it exists.
   */
  public invalidate(): void {
    this.cached = undefined
  }

  public async locate(signal?: AbortSignal): Promise<RuntimeLookupResult> {
    if (this.cached !== undefined) return this.cached
    if (signal?.aborted === true) throw runtimeDetectionCancelled(signal)
    const locations: string[] = []
    const candidates = this.candidates(undefined)
    const configured = candidates.find((candidate) => candidate.source === 'configured')
    // An explicit executable is an operator decision.  If it exists but is
    // an incompatible version, surface that fact instead of silently falling
    // back to a different PATH binary.
    if (configured !== undefined && (await this.dependencies.fileExists(configured.path))) {
      this.rememberLocation(locations, configured.path)
      const result = {
        runtime: await this.inspect(configured, signal),
        searchedLocations: [...locations],
      }
      if (result.runtime.supported) this.memoize(result, configured.path, 'configured')
      return result
    }

    // The persisted hint turns the repeated cold-start scan into one
    // fileExists plus one version probe. An unsupported or vanished hint
    // falls through to the ordinary scan below.
    const hint = this.dependencies.lastKnownRuntimePath?.()
    if (hint !== undefined && hint.path !== configured?.path) {
      const hintPath = pathApi(this.dependencies.os).normalize(hint.path)
      if (await this.dependencies.fileExists(hintPath)) {
        this.rememberLocation(locations, hintPath)
        const hinted = await this.inspect({ path: hintPath, source: hint.source }, signal)
        if (hinted.supported) {
          const result = { runtime: hinted, searchedLocations: [...locations] }
          this.memoize(result, hintPath, hint.source)
          return result
        }
      }
    }

    const initial = await this.findSupported(
      candidates.filter((candidate) => candidate !== configured),
      locations,
      signal,
    )
    if (initial.runtime?.supported === true) {
      const result = { runtime: initial.runtime, searchedLocations: [...locations] }
      this.memoize(result, initial.runtime.executable, initial.runtime.source)
      return result
    }

    // Explicit configuration and PATH take precedence over npm discovery.
    // This also avoids spawning npm on the common configured-runtime path.
    let prefix: string | undefined
    try {
      prefix = await this.dependencies.npmGlobalPrefix(signal)
    } catch (error) {
      if (signal?.aborted) throw runtimeDetectionCancelled(signal)
      throw error
    }
    if (signal?.aborted) throw runtimeDetectionCancelled(signal)
    const npmCandidates = this.candidates(prefix).filter(
      (candidate) => !candidates.some((known) => known.path.toLowerCase() === candidate.path.toLowerCase()),
    )
    const npmRuntime = await this.findSupported(npmCandidates, locations, signal)
    const runtime =
      npmRuntime.runtime?.supported === true ? npmRuntime.runtime : (initial.runtime ?? npmRuntime.runtime)
    if (runtime === undefined) {
      const timeout = initial.timeout ?? npmRuntime.timeout
      if (timeout !== undefined) throw timeout
    }
    const result: RuntimeLookupResult = {
      ...(runtime === undefined ? {} : { runtime }),
      searchedLocations: [...locations],
    }
    if (runtime?.supported === true) this.memoize(result, runtime.executable, runtime.source)
    return result
  }

  private memoize(result: RuntimeLookupResult, executablePath: string, source: DshRuntime['source']): void {
    this.cached = result
    if (source === 'configured' || source === 'bundled') return
    // A configured path is re-read from settings on every cold locate, so
    // persisting it would keep a removed setting alive; only discovered
    // executables benefit from the cross-session hint.
    void this.dependencies.rememberRuntimePath?.({ path: executablePath, source })
  }

  public async inspectExecutable(executable: string, signal?: AbortSignal): Promise<DshRuntime> {
    if (!(await this.dependencies.fileExists(executable)))
      throw new AppError({
        code: 'DSH_NOT_FOUND',
        message: 'The selected DSH executable was not found.',
        retryable: false,
      })
    return this.inspect(
      { path: pathApi(this.dependencies.os).normalize(executable), source: 'configured' },
      signal,
    )
  }

  private async findSupported(
    candidates: readonly Candidate[],
    locations: string[],
    signal?: AbortSignal,
  ): Promise<RuntimeSearchResult> {
    let incompatible: DshRuntime | undefined
    let timeout: AppError | undefined
    for (const candidate of candidates) {
      if (signal?.aborted === true) throw runtimeDetectionCancelled(signal)
      if (!(await this.dependencies.fileExists(candidate.path))) continue
      // Report only runtime candidates that actually exist. Listing every
      // derived candidate from PATH makes the diagnostic look like a
      // successful search while hiding the one path that matters.
      this.rememberLocation(locations, candidate.path)
      try {
        const runtime = await this.inspect(candidate, signal)
        if (runtime.supported) return { runtime, timeout }
        incompatible ??= runtime
      } catch (error) {
        if (signal?.aborted) throw error
        if (isRuntimeProbeTimeout(error)) timeout = error
      }
    }
    return { runtime: incompatible, timeout }
  }

  private rememberLocation(locations: string[], candidatePath: string): void {
    const normalized = pathApi(this.dependencies.os).normalize(candidatePath)
    const key = this.dependencies.os === 'windows' ? normalized.toLowerCase() : normalized
    if (
      locations.some((location) => {
        const existing = pathApi(this.dependencies.os).normalize(location)
        const existingKey = this.dependencies.os === 'windows' ? existing.toLowerCase() : existing
        return existingKey === key
      })
    )
      return
    locations.push(normalized)
  }

  private async inspect(candidate: Candidate, signal?: AbortSignal): Promise<DshRuntime> {
    if (signal?.aborted === true)
      throw signal.reason instanceof AppError
        ? signal.reason
        : new AppError({
            code: 'REQUEST_CANCELLED',
            message: 'Runtime detection was cancelled.',
            retryable: true,
          })
    const timeoutAbort = new AbortController()
    const probeSignal =
      signal === undefined ? timeoutAbort.signal : AbortSignal.any([signal, timeoutAbort.signal])
    try {
      const version = await withTimeout(
        this.dependencies.executeVersion(candidate.path, probeSignal),
        3_000,
        signal,
        () => timeoutAbort.abort(new Error('runtime version detection cancelled')),
      )
      return {
        executable: candidate.path,
        version: normalizeVersion(version),
        supported: isDshVersion(version),
        compatibility: isKnownDshVersion(normalizeVersion(version)) ? 'known' : 'unknown',
        source: candidate.source,
      }
    } finally {
      timeoutAbort.abort()
    }
  }

  private candidates(npmPrefix: string | undefined): readonly Candidate[] {
    const result: Candidate[] = []
    const seen = new Set<string>()
    const pathModule = pathApi(this.dependencies.os)
    const add = (value: string | undefined, source: DshRuntime['source']): void => {
      if (value === undefined || value.trim() === '') return
      const normalized = pathModule.normalize(value)
      const key = this.dependencies.os === 'windows' ? normalized.toLowerCase() : normalized
      if (seen.has(key)) return
      seen.add(key)
      result.push({ path: normalized, source })
    }

    const configured = this.dependencies.configuredPath()
    add(configured, 'configured')
    const executableNames =
      this.dependencies.os === 'windows' ? ['dsh.cmd', 'dsh.bat', 'dsh.exe', 'dsh'] : ['dsh']
    for (const entry of this.dependencies.pathEntries())
      for (const executableName of executableNames) add(pathModule.join(entry, executableName), 'path')
    // npm's global prefix is a directory, not an executable. Keep the lookup
    // platform-specific and never invoke a shell to ask npm for a command.
    if (npmPrefix !== undefined) {
      for (const executableName of executableNames) {
        add(
          this.dependencies.os === 'windows'
            ? pathModule.join(npmPrefix, executableName)
            : pathModule.join(npmPrefix, 'bin', executableName),
          'npm-global',
        )
        add(pathModule.join(npmPrefix, 'node_modules', '.bin', executableName), 'npm-global')
      }
    }
    return result
  }
}

interface Candidate {
  readonly path: string
  readonly source: DshRuntime['source']
}

function pathApi(os: OperatingSystem): typeof path.posix {
  return os === 'windows' ? path.win32 : path.posix
}

function normalizeVersion(output: string): string {
  const firstLine = output.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ''
  const match = firstLine.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/u)
  return (match?.[0] ?? firstLine).slice(0, 128)
}

function isDshVersion(output: string): boolean {
  // Version syntax is intentionally not a gate.  Future DSH builds may use a
  // different label; the adapter probe is the compatibility boundary and can
  // surface a warning while retaining best-effort functionality.
  return normalizeVersion(output) !== ''
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  cancelUnderlying?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      cancelUnderlying?.()
      finish(undefined, runtimeVersionTimeout())
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (value: T | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error === undefined) resolve(value as T)
      else reject(error instanceof Error ? error : new Error('Runtime version detection failed.'))
    }
    const onAbort = (): void => {
      cancelUnderlying?.()
      finish(
        undefined,
        signal?.reason instanceof AppError
          ? signal.reason
          : new AppError({
              code: 'REQUEST_CANCELLED',
              message: 'Runtime detection was cancelled.',
              retryable: true,
            }),
      )
    }
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

interface RuntimeSearchResult {
  readonly runtime: DshRuntime | undefined
  readonly timeout: AppError | undefined
}

function runtimeVersionTimeout(): AppError {
  return new AppError({
    code: 'BACKEND_UNREACHABLE',
    message: 'Timed out while checking the DSH runtime version.',
    retryable: true,
    context: { operation: 'runtime.version', timedOut: true },
  })
}

function runtimeDetectionCancelled(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError
    ? signal.reason
    : new AppError({
        code: 'REQUEST_CANCELLED',
        message: 'Runtime detection was cancelled.',
        retryable: true,
        cause: signal.reason,
      })
}

function isRuntimeProbeTimeout(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.code === 'BACKEND_UNREACHABLE' &&
    error.context?.operation === 'runtime.version' &&
    error.context?.timedOut === true
  )
}
