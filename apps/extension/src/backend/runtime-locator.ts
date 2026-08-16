import type { RuntimeLocator } from '@dsh-vscode/application'
import type { DshRuntime, OperatingSystem } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import path from 'node:path'

export interface RuntimeLocatorDependencies {
  readonly os: OperatingSystem
  readonly configuredPath: () => string | undefined
  readonly pathEntries: () => readonly string[]
  readonly npmGlobalPrefix: (signal?: AbortSignal) => Promise<string | undefined>
  readonly fileExists: (path: string) => Promise<boolean>
  readonly executeVersion: (executable: string, signal?: AbortSignal) => Promise<string>
}

export class DshRuntimeLocator implements RuntimeLocator {
  private locations: readonly string[] = []

  public constructor(private readonly dependencies: RuntimeLocatorDependencies) {}

  public async locate(signal?: AbortSignal): Promise<DshRuntime | undefined> {
    this.locations = []
    const candidates = this.candidates(undefined)
    const configured = candidates.find((candidate) => candidate.source === 'configured')
    // An explicit executable is an operator decision.  If it exists but is
    // an incompatible version, surface that fact instead of silently falling
    // back to a different PATH binary.
    if (configured !== undefined && (await this.dependencies.fileExists(configured.path)))
      return this.inspect(configured, signal)

    const initial = await this.findSupported(
      candidates.filter((candidate) => candidate !== configured),
      signal,
    )
    if (initial?.supported === true) return initial

    // Explicit configuration and PATH take precedence over npm discovery.
    // This also avoids spawning npm on the common configured-runtime path.
    const prefix = await this.dependencies.npmGlobalPrefix(signal)
    const npmCandidates = this.candidates(prefix).filter(
      (candidate) => !candidates.some((known) => known.path.toLowerCase() === candidate.path.toLowerCase()),
    )
    const npmRuntime = await this.findSupported(npmCandidates, signal)
    return npmRuntime?.supported === true ? npmRuntime : (initial ?? npmRuntime)
  }

  public searchedLocations(): readonly string[] {
    return this.locations
  }

  public async inspectExecutable(executable: string, signal?: AbortSignal): Promise<DshRuntime> {
    if (!(await this.dependencies.fileExists(executable)))
      throw new AppError({
        code: 'DSH_NOT_FOUND',
        message: 'The selected DSH executable was not found.',
        retryable: false,
      })
    return this.inspect({ path: path.normalize(executable), source: 'configured' }, signal)
  }

  private async findSupported(
    candidates: readonly Candidate[],
    signal?: AbortSignal,
  ): Promise<DshRuntime | undefined> {
    this.locations = [...this.locations, ...candidates.map((candidate) => candidate.path)]
    let incompatible: DshRuntime | undefined
    for (const candidate of candidates) {
      if (signal?.aborted === true)
        throw new AppError({
          code: 'REQUEST_CANCELLED',
          message: 'Runtime detection was cancelled.',
          retryable: true,
        })
      if (!(await this.dependencies.fileExists(candidate.path))) continue
      try {
        const runtime = await this.inspect(candidate, signal)
        if (runtime.supported) return runtime
        incompatible ??= runtime
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return incompatible
  }

  private async inspect(candidate: Candidate, signal?: AbortSignal): Promise<DshRuntime> {
    const version = await withTimeout(this.dependencies.executeVersion(candidate.path, signal), 3_000, signal)
    return {
      executable: candidate.path,
      version: normalizeVersion(version),
      supported: isSupportedVersion(version),
      source: candidate.source,
    }
  }

  private candidates(npmPrefix: string | undefined): readonly Candidate[] {
    const result: Candidate[] = []
    const seen = new Set<string>()
    const add = (value: string | undefined, source: DshRuntime['source']): void => {
      if (value === undefined || value.trim() === '') return
      const normalized = path.normalize(value)
      const key = this.dependencies.os === 'windows' ? normalized.toLowerCase() : normalized
      if (seen.has(key)) return
      seen.add(key)
      result.push({ path: normalized, source })
    }

    const configured = this.dependencies.configuredPath()
    add(configured, 'configured')
    const executableName = this.dependencies.os === 'windows' ? 'dsh.cmd' : 'dsh'
    for (const entry of this.dependencies.pathEntries()) add(path.join(entry, executableName), 'path')
    // npm's global prefix is a directory, not an executable. Keep the lookup
    // platform-specific and never invoke a shell to ask npm for a command.
    if (npmPrefix !== undefined) {
      add(
        this.dependencies.os === 'windows'
          ? path.join(npmPrefix, executableName)
          : path.join(npmPrefix, 'bin', executableName),
        'npm-global',
      )
      add(path.join(npmPrefix, 'node_modules', '.bin', executableName), 'npm-global')
    }
    return result
  }
}

interface Candidate {
  readonly path: string
  readonly source: DshRuntime['source']
}

function normalizeVersion(output: string): string {
  const match = output.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)
  return match?.[0] ?? output.trim()
}

function isSupportedVersion(output: string): boolean {
  return normalizeVersion(output) === '0.1.0-rc.6'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => finish(undefined, new Error('runtime version timeout')), timeoutMs)
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
    const onAbort = (): void =>
      finish(
        undefined,
        signal?.reason instanceof Error ? signal.reason : new Error('runtime version detection cancelled'),
      )
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
