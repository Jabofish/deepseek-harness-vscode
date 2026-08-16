import type { PluginDescriptor, PluginRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { unavailable } from '../versions/rc6/rpc.js'

export class Rc6PluginRepository implements PluginRepository {
  public constructor(_transport: DshTransport) {}
  public list(_signal?: AbortSignal): Promise<readonly PluginDescriptor[]> {
    return Promise.reject(unavailable('plugin inventory'))
  }
  public configure(_pluginId: string, _enabled: boolean, _signal?: AbortSignal): Promise<void> {
    return Promise.reject(unavailable('plugin inventory/configuration'))
  }
}
