import type {
  DshRuntime,
  DshRuntimeUpdateProgress,
  DshUpdateFailure,
  DshUpdateSnapshot,
} from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'
import { DSH_PACKAGE_NAME, isDshPackageVersion as isDshSemVerVersion } from '@dsh-vscode/dsh-adapter'

import {
  RUNTIME_INSTALL_MAX_BUFFER,
  RUNTIME_INSTALL_TIMEOUT_MS,
  runtimeInstallationFailureMessage,
  withNpmFetchDefaults,
} from './runtime-installation.js'

const UPDATE_CHECK_TIMEOUT_MS = 60_000
const UPDATE_MAX_BUFFER = RUNTIME_INSTALL_MAX_BUFFER
export interface RuntimeCommandOptions {
  readonly timeout: number
  readonly maxBuffer: number
  readonly env?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  readonly onHeartbeat?: (elapsedMs: number, silentMs: number) => void
  /** Stop owned runtime processes only after staging has been verified. */
  readonly beforeReplace?: () => Promise<void>
}

export interface RuntimeCommandResult {
  readonly stdout: string
  readonly stderr: string
}

export type ExecuteRuntimeCommand = (
  executable: string,
  args: readonly string[],
  options: RuntimeCommandOptions,
) => Promise<RuntimeCommandResult>

export interface DshRuntimeUpdaterDependencies {
  readonly npmExecutable: () => string
  readonly locateRuntime: (signal?: AbortSignal) => Promise<DshRuntime | undefined>
  readonly execute: ExecuteRuntimeCommand
  /** Safe, phase-only progress; never include npm output, paths, or secrets. */
  readonly onProgress?: (progress: DshRuntimeUpdateProgress) => void
  readonly environment?: () => NodeJS.ProcessEnv
  readonly now?: () => Date
  readonly activeVersion?: () => string | undefined
  readonly canRestart?: () => boolean
  /**
   * Stop only an extension-owned runtime before npm replaces shared files.
   * The returned callback must restore the connection after npm exits.
   */
  readonly prepareManagedUpdate?: () => Promise<(() => Promise<void>) | undefined>
}

interface RegistryMetadata {
  readonly versions: readonly string[]
  readonly latestTagVersion?: string
  readonly nextTagVersion?: string
}

export class DshRuntimeUpdater {
  private cached: DshUpdateSnapshot | undefined
  private inFlight: Promise<DshUpdateSnapshot> | undefined
  private metadata: RegistryMetadata | undefined
  private revision = 0
  private installing: { readonly version: string; readonly operation: Promise<DshUpdateSnapshot> } | undefined

  public constructor(private readonly dependencies: DshRuntimeUpdaterDependencies) {}

  public checkForUpdates(force = false, signal?: AbortSignal): Promise<DshUpdateSnapshot> {
    if (this.installing !== undefined) return this.installing.operation
    if (
      !force &&
      this.cached?.status === 'ready' &&
      (this.dependencies.now?.().getTime() ?? Date.now()) - Date.parse(this.cached.checkedAt) < 30_000
    )
      return Promise.resolve(this.cached)
    if (this.inFlight !== undefined) return this.inFlight

    const revision = ++this.revision
    const operation = this.checkOnce(signal, revision).catch((error: unknown) => {
      if (revision === this.revision) {
        this.cached = undefined
        this.emitProgress({ phase: 'failed' })
      }
      throw error
    })
    this.inFlight = operation
    void operation.then(
      () => {
        if (this.inFlight === operation) this.inFlight = undefined
      },
      () => {
        if (this.inFlight === operation) this.inFlight = undefined
      },
    )
    return operation
  }

  public installVersion(version: string, signal?: AbortSignal): Promise<DshUpdateSnapshot> {
    if (this.installing !== undefined) {
      if (this.installing.version === version.trim()) return this.installing.operation
      return Promise.reject(
        new AppError({
          code: 'BACKEND_BUSY',
          message: 'A DSH installation is already running.',
          retryable: true,
        }),
      )
    }
    const revision = ++this.revision
    this.inFlight = undefined
    this.cached = undefined
    const operation = this.runInstall(version, signal, revision).catch((error: unknown) => {
      this.cached = undefined
      this.emitProgress({ phase: 'failed', version: version.trim() })
      throw error
    })
    this.installing = { version: version.trim(), operation }
    const release = (): void => {
      if (this.installing?.operation === operation) this.installing = undefined
    }
    void operation.then(release, release)
    return operation
  }

  private async runInstall(
    version: string,
    signal: AbortSignal | undefined,
    revision: number,
  ): Promise<DshUpdateSnapshot> {
    const requested = version.trim()
    if (!isDshPackageVersion(requested))
      throw updateError(
        'invalid-version',
        'Select an exact DSH version from the upstream version list.',
        false,
      )
    this.emitProgress({ phase: 'checking', version: requested })
    const checked = await this.checkOnce(signal, revision, false)
    if (checked.status !== 'ready' || !checked.availableVersions.includes(requested)) {
      throw updateError(
        'metadata-unavailable',
        'The selected DSH version could not be verified against the upstream registry.',
        true,
        undefined,
        checked.failure === undefined ? undefined : `Registry check failed: ${checked.failure}.`,
      )
    }
    if (checked.globalVersion === requested) {
      // Installing the exact global version again is a no-op. Keep this guard
      // in the Host as well as the Webview because the UI snapshot can be
      // stale or a caller can bypass the Webview action entirely.
      this.cached =
        checked.currentVersion !== undefined && checked.currentVersion !== requested
          ? { ...checked, restartRequired: true }
          : checked
      this.emitProgress({ phase: 'completed', version: requested, snapshot: this.cached })
      return this.cached
    }

    const startedAt = Date.now()
    let lastPublished = 0
    this.cached = undefined
    let resumeManagedRuntime: (() => Promise<void>) | undefined
    this.emitProgress({ phase: 'downloading', version: requested, startedAt })
    let installError: unknown
    try {
      await this.dependencies.execute(
        this.dependencies.npmExecutable(),
        [
          'install',
          '--global',
          `${DSH_PACKAGE_NAME}@${requested}`,
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          '--loglevel=info',
        ],
        {
          ...this.commandOptions(RUNTIME_INSTALL_TIMEOUT_MS, signal),
          beforeReplace: async () => {
            try {
              resumeManagedRuntime = await this.dependencies.prepareManagedUpdate?.()
            } catch (error) {
              throw updateError(
                'install-failed',
                'The managed DSH could not be stopped before updating. Reconnect and retry.',
                true,
                error,
              )
            }
          },
          onOutput: () => {
            const now = Date.now()
            if (revision === this.revision && now - lastPublished >= 1_000) {
              lastPublished = now
              this.emitProgress({ phase: 'downloading', version: requested, startedAt, lastActivityAt: now })
            }
          },
        },
      )
    } catch (error) {
      installError = error
    }
    let resumeError: unknown
    if (resumeManagedRuntime !== undefined) {
      try {
        await resumeManagedRuntime()
      } catch (error) {
        resumeError = error
      }
    }
    if (installError !== undefined) {
      this.cached = undefined
      if (
        installError instanceof AppError &&
        (installError.code === 'BACKEND_BUSY' || installError.context?.operation === 'runtime.install')
      )
        throw installError
      if (isCancellation(installError, signal)) throw cancelledError(installError)
      if (isMissingExecutable(installError))
        throw updateError(
          'npm-not-found',
          'npm was not found in the Extension Host environment. Copy the install command or open a terminal.',
          true,
          installError,
        )
      const failureMessage = runtimeInstallationFailureMessage(installError)
      throw updateError(
        'install-failed',
        failureMessage ??
          'The selected DSH version could not be installed. Check the npm install log and try again.',
        true,
        installError,
        resumeError === undefined ? undefined : 'The managed DSH could not be reconnected.',
      )
    }
    if (resumeError !== undefined)
      throw updateError(
        'install-failed',
        'npm finished, but the managed DSH could not be restarted. Check the connection and retry.',
        true,
        resumeError,
      )

    this.emitProgress({ phase: 'verifying', version: requested, startedAt })
    const globalVersion = await this.readGlobalVersion()
    if (globalVersion !== requested) {
      throw updateError(
        'verify-failed',
        'DSH installation finished, but the selected global version could not be verified.',
        true,
      )
    }
    let runtime: DshRuntime | undefined
    const probeAbort = new AbortController()
    let probeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      runtime = await Promise.race([
        this.dependencies.locateRuntime(probeAbort.signal),
        new Promise<undefined>((resolve) => {
          probeTimer = setTimeout(() => {
            probeAbort.abort()
            resolve(undefined)
          }, 5_000)
        }),
      ])
    } catch {
      // The package was verified through npm global state. A separately
      // configured executable may still be broken, so do not turn a completed
      // package update into a false install failure.
      runtime = undefined
    } finally {
      clearTimeout(probeTimer)
      probeAbort.abort()
    }
    const metadata = this.metadata ?? metadataFromSnapshot(checked)
    const snapshot = this.snapshot('ready', runtime, globalVersion, metadata)
    this.cached = snapshot
    this.emitProgress({ phase: 'completed', version: requested, startedAt, snapshot: this.cached })
    return this.cached
  }

  private async checkOnce(
    signal: AbortSignal | undefined,
    revision: number,
    progress = true,
  ): Promise<DshUpdateSnapshot> {
    if (progress) this.emitProgress({ phase: 'checking' })
    const checkedAt = this.timestamp()
    const [runtimeResult, metadataResult, globalResult] = await Promise.allSettled([
      this.dependencies.locateRuntime(signal),
      this.readMetadata(signal),
      this.readGlobalVersion(signal),
    ])
    // Another surface may have installed DSH while this registry request was pending.
    if (revision !== this.revision)
      return this.installing?.operation ?? this.cached ?? this.checkForUpdates(true, signal)
    if (
      signal?.aborted === true ||
      isRejectedCancellation(runtimeResult, signal) ||
      isRejectedCancellation(metadataResult, signal) ||
      isRejectedCancellation(globalResult, signal)
    )
      throw cancelledError(signal?.reason)

    const runtime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : undefined
    const currentVersion = this.dependencies.activeVersion?.() ?? runtime?.version
    const globalVersion = globalResult.status === 'fulfilled' ? globalResult.value : undefined
    if (metadataResult.status !== 'fulfilled') {
      const snapshot: DshUpdateSnapshot = {
        status: 'unavailable',
        ...(currentVersion === undefined ? {} : { currentVersion }),
        ...(runtime === undefined ? {} : { currentSource: runtime.source }),
        ...(globalVersion === undefined ? {} : { globalVersion }),
        availableVersions: [],
        updateAvailable: false,
        checkedAt,
        failure: failureFor(metadataResult.reason),
      }
      if (revision === this.revision) {
        this.cached = undefined
        if (progress) this.emitProgress({ phase: 'failed' })
      }
      return snapshot
    }

    if (revision === this.revision) this.metadata = metadataResult.value
    const snapshot = this.snapshot('ready', runtime, globalVersion, metadataResult.value, checkedAt)
    if (revision === this.revision) {
      this.cached = snapshot
      if (progress) this.emitProgress({ phase: 'completed' })
    }
    return snapshot
  }

  private emitProgress(progress: DshRuntimeUpdateProgress): void {
    try {
      this.dependencies.onProgress?.(progress)
    } catch {
      // Progress is advisory. A disconnected Webview must never fail npm work.
    }
  }

  private async readMetadata(signal?: AbortSignal): Promise<RegistryMetadata> {
    const result = await this.dependencies.execute(
      this.dependencies.npmExecutable(),
      ['view', DSH_PACKAGE_NAME, 'versions', 'dist-tags', '--json'],
      this.commandOptions(UPDATE_CHECK_TIMEOUT_MS, signal),
    )
    return parseNpmMetadata(result.stdout)
  }

  private async readGlobalVersion(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const result = await this.dependencies.execute(
        this.dependencies.npmExecutable(),
        ['list', '--global', DSH_PACKAGE_NAME, '--depth=0', '--json'],
        this.commandOptions(15_000, signal),
      )
      return parseGlobalVersion(result.stdout)
    } catch (error) {
      if (isCancellation(error, signal)) throw error
      return typeof error === 'object' &&
        error !== null &&
        'stdout' in error &&
        typeof error.stdout === 'string'
        ? parseGlobalVersion(error.stdout)
        : undefined
    }
  }

  private snapshot(
    status: 'ready',
    runtime: DshRuntime | undefined,
    globalVersion: string | undefined,
    metadata: RegistryMetadata,
    checkedAt = this.timestamp(),
  ): DshUpdateSnapshot {
    const latestVersion = metadata.versions[0]
    const currentVersion = this.dependencies.activeVersion?.() ?? runtime?.version
    const installedVersion = globalVersion ?? currentVersion
    const updateAvailable =
      latestVersion !== undefined &&
      installedVersion !== undefined &&
      compareVersions(latestVersion, installedVersion) > 0
    return {
      status,
      ...(currentVersion === undefined ? {} : { currentVersion }),
      ...(runtime === undefined ? {} : { currentSource: runtime.source }),
      ...(globalVersion === undefined ? {} : { globalVersion }),
      ...(latestVersion === undefined ? {} : { latestVersion }),
      ...(metadata.latestTagVersion === undefined ? {} : { latestTagVersion: metadata.latestTagVersion }),
      ...(metadata.nextTagVersion === undefined ? {} : { nextTagVersion: metadata.nextTagVersion }),
      availableVersions: metadata.versions,
      updateAvailable,
      checkedAt,
      ...(this.dependencies.canRestart === undefined ? {} : { canRestart: this.dependencies.canRestart() }),
      ...(globalVersion !== undefined && currentVersion !== undefined && globalVersion !== currentVersion
        ? { restartRequired: true }
        : {}),
    }
  }

  private commandOptions(timeout: number, signal?: AbortSignal): RuntimeCommandOptions {
    const checking = timeout < RUNTIME_INSTALL_TIMEOUT_MS
    return {
      timeout,
      maxBuffer: UPDATE_MAX_BUFFER,
      env: withNpmFetchDefaults(this.dependencies.environment?.() ?? {}, checking),
      ...(signal === undefined ? {} : { signal }),
    }
  }

  private timestamp(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString()
  }
}

export function parseNpmMetadata(output: string): RegistryMetadata {
  let value: unknown
  try {
    value = JSON.parse(output.replace(/^\uFEFF/u, '').trim()) as unknown
  } catch (error) {
    throw new Error('The npm registry returned invalid JSON.', { cause: error })
  }
  const record = asRecord(value)
  // `npm view <package> --json` returns the complete package document, while
  // `npm view <package> versions --json` returns the version array directly.
  // Keep both shapes compatible because npm/DSH installations in the wild may
  // still be running the older command path.
  const versionValue = record?.versions ?? value
  const rawVersions = Array.isArray(versionValue)
    ? versionValue
    : typeof versionValue === 'string'
      ? [versionValue]
      : []
  const versions = uniqueSortedVersions(
    rawVersions.filter((entry): entry is string => typeof entry === 'string'),
  )
  if (versions.length === 0) throw new Error('The npm registry returned no valid DSH versions.')
  const tags = asRecord(record?.['dist-tags'])
  const latestTagVersion = validTag(tags?.latest, versions)
  const nextTagVersion = validTag(tags?.next, versions)
  return {
    versions,
    ...(latestTagVersion === undefined ? {} : { latestTagVersion }),
    ...(nextTagVersion === undefined ? {} : { nextTagVersion }),
  }
}

export function isDshPackageVersion(value: string): boolean {
  return isDshSemVerVersion(value)
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const [leftPart, rightPart] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : undefined
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
    if (leftNumber !== undefined) return -1
    if (rightNumber !== undefined) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function uniqueSortedVersions(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(isDshPackageVersion))].sort((left, right) => compareVersions(right, left))
}

function validTag(value: unknown, versions: readonly string[]): string | undefined {
  return typeof value === 'string' && versions.includes(value) ? value : undefined
}

function parseGlobalVersion(output: string): string | undefined {
  try {
    const root = asRecord(JSON.parse(output) as unknown)
    const dependencies = asRecord(root?.dependencies)
    const packageRecord = asRecord(dependencies?.[DSH_PACKAGE_NAME])
    const version = packageRecord?.version
    return typeof version === 'string' && isDshPackageVersion(version) ? version : undefined
  } catch {
    return undefined
  }
}

function parseVersion(value: string): {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
} {
  const match = value.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  )
  if (match === null) return { major: 0, minor: 0, patch: 0, prerelease: [] }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function metadataFromSnapshot(snapshot: DshUpdateSnapshot): RegistryMetadata {
  return {
    versions: snapshot.availableVersions,
    ...(snapshot.latestTagVersion === undefined ? {} : { latestTagVersion: snapshot.latestTagVersion }),
    ...(snapshot.nextTagVersion === undefined ? {} : { nextTagVersion: snapshot.nextTagVersion }),
  }
}

function failureFor(error: unknown): DshUpdateFailure {
  if (isMissingExecutable(error)) return 'npm-not-found'
  if (
    error instanceof Error &&
    (error.message.includes('invalid JSON') || error.message.includes('no valid DSH versions'))
  )
    return 'invalid-response'
  return 'registry-unavailable'
}

function isMissingExecutable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { readonly code?: unknown }).code === 'ENOENT'
    : false
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

function isRejectedCancellation(
  result: PromiseSettledResult<unknown>,
  signal: AbortSignal | undefined,
): boolean {
  return result.status === 'rejected' && isCancellation(result.reason, signal)
}

function cancelledError(cause: unknown): AppError {
  return new AppError({
    code: 'REQUEST_CANCELLED',
    message: 'DSH update operation was cancelled.',
    retryable: true,
    cause,
    context: { operation: 'runtime.update', reason: 'cancelled' },
  })
}

function updateError(
  reason: 'invalid-version' | 'metadata-unavailable' | 'npm-not-found' | 'install-failed' | 'verify-failed',
  message: string,
  retryable: boolean,
  cause?: unknown,
  detail?: string,
): AppError {
  return new AppError({
    code:
      reason === 'npm-not-found' || reason === 'verify-failed'
        ? 'DSH_NOT_FOUND'
        : reason === 'metadata-unavailable'
          ? 'CAPABILITY_UNAVAILABLE'
          : 'INVALID_CONFIGURATION',
    message,
    retryable,
    ...(cause === undefined ? {} : { cause }),
    context: {
      operation: 'runtime.update',
      reason,
      ...(detail === undefined ? {} : { detail }),
    },
  })
}
