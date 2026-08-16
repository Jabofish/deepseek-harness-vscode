import type { DshSettingsSchema } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { BackendService } from '../services/backend-service.js'

export class SettingsUseCases {
  public constructor(private readonly backendService: BackendService) {}

  public read(
    signal?: AbortSignal,
  ): Promise<{ readonly schema: DshSettingsSchema; readonly values: Readonly<Record<string, unknown>> }> {
    return unimplemented('read DSH settings and schema', [
      'read schema and values from one connection revision',
      'remove secret values and expose only configured/missing status',
      `signal present ${String(signal !== undefined)}; backend guard ${String(this.backendService !== undefined)}`,
    ])
  }

  public update(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
    return unimplemented<Promise<void>>('update one DSH setting', [
      'validate path and value against the current server-provided schema',
      'honor live versus restart-required semantics and never auto-restart external DSH',
      'refresh and rollback UI state after server rejection',
      `path ${path}; value type ${typeof value}; signal present ${String(signal !== undefined)}`,
    ])
  }
}
