import type { PluginDescriptor, PluginRepository } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'

export class Rc6PluginRepository implements PluginRepository {
  public constructor(private readonly transport: DshTransport) {}

  public list(signal?: AbortSignal): Promise<readonly PluginDescriptor[]> {
    return unimplemented('rc6 list plugin inventory', this.requirements('list', signal))
  }

  public configure(pluginId: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
    return unimplemented(
      'rc6 configure plugin',
      this.requirements(`configure:${pluginId}:${String(enabled)}`, signal),
    )
  }

  private requirements(operation: string, signal: AbortSignal | undefined): readonly string[] {
    return [
      'read inventory and supported configuration operations from connected DSH',
      'never enable, install, disable, uninstall, or restart a plugin without explicit user action',
      'show restart/reconnect requirements and never restart an external DSH automatically',
      'fall back to generic tool and event rendering for unknown plugins',
      `operation ${operation}; signal present ${String(signal !== undefined)}; transport available ${String(this.transport !== undefined)}`,
    ]
  }
}
