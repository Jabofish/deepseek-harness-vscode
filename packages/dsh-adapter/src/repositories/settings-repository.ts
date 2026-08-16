import type { DshSettingsSchema, SettingsRepository } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6SettingsRepository implements SettingsRepository {
  public constructor(private readonly transport: DshTransport) {}

  public schema(signal?: AbortSignal): Promise<DshSettingsSchema> {
    return unimplemented('rc6 settings schema', this.requirements('schema', signal))
  }

  public read(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    return unimplemented('rc6 read settings', this.requirements('read', signal))
  }

  public update(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 update one setting',
      this.requirements(`update:${path}:${typeof value}`, signal),
    )
  }

  public replace(value: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 replace settings',
      this.requirements(`replace:${Object.keys(value).length}`, signal),
    )
  }

  private requirements(operation: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'use official rc6 schema/read/update/replace RPCs',
      'render schema dynamically and enforce live versus restart-required semantics',
      'represent secret fields only as configured or missing',
      'never copy DSH settings into VS Code settings except extension-owned connection defaults',
      `operation ${operation}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
