import { Alpha214PluginBundleRepository } from '../alpha214/plugin-manager-repository.js'
import type { PluginManagerWireProfile } from '../rc172/plugin-manager-repository.js'

export class Alpha222PluginBundleRepository extends Alpha214PluginBundleRepository {
  protected override readonly wireProfile: PluginManagerWireProfile = {
    restartReason: true,
    alreadyInstalled: true,
    unsupportedPlatform: true,
  }
}
