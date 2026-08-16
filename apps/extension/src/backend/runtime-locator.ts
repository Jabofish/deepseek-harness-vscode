import type { RuntimeLocator } from '@dsh-vscode/application'
import type { DshRuntime, OperatingSystem } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

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

  public locate(signal?: AbortSignal): Promise<DshRuntime | undefined> {
    return unimplemented<Promise<DshRuntime | undefined>>('cross-platform DSH executable discovery', [
      'search configured path, process PATH, and npm global bin in that order without shell interpolation',
      'use dsh.cmd on Windows where appropriate and executable dsh on POSIX',
      'run --version with timeout and require a supported semver before accepting a candidate',
      'deduplicate normalized paths and record safe searched paths for the missing-runtime UI',
      'never execute a file outside an exact discovered candidate path',
      `os ${this.dependencies.os}; signal present ${String(signal !== undefined)}`,
    ])
  }

  public searchedLocations(): readonly string[] {
    return this.locations
  }
}
