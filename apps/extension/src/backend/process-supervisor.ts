import type { ProcessSupervisor } from '@dsh-vscode/application'
import type { DshRuntime, ManagedProcessHandle } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

export interface SpawnedChild {
  readonly pid: number
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  readonly kill: () => void
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
}

export interface ProcessSupervisorDependencies {
  readonly spawn: (executable: string, args: readonly string[]) => SpawnedChild
  readonly managedPort: () => number
}

export class DshProcessSupervisor implements ProcessSupervisor {
  private active: ManagedProcessHandle | undefined

  public constructor(private readonly dependencies: ProcessSupervisorDependencies) {}

  public start(runtime: DshRuntime, signal?: AbortSignal): Promise<ManagedProcessHandle> {
    return unimplemented<Promise<ManagedProcessHandle>>(
      'start and supervise extension-owned DSH web process',
      [
        'allow at most one managed child and coalesce concurrent starts',
        'spawn executable directly with arguments web --host 127.0.0.1 --port configured-or-zero',
        'never use a shell and never concatenate user settings into a command line',
        'parse the actual listening port from structured or strictly matched startup output',
        'wait for health readiness with timeout and fail if the child exits early',
        'capture bounded redacted diagnostics without retaining prompts or secrets',
        'stop only this exact child with graceful-then-forced shutdown during extension disposal',
        `runtime ${runtime.executable}; configured port ${this.dependencies.managedPort()}; signal present ${String(signal !== undefined)}; active present ${String(this.active !== undefined)}`,
      ],
    )
  }
}
