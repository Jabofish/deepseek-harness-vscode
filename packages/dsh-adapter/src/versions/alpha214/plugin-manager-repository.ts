import { Alpha213PluginBundleRepository } from '../alpha213/plugin-manager-repository.js'
import type { PluginManagerWireProfile } from '../rc172/plugin-manager-repository.js'

/** alpha.4 declares already-installed as a management refusal as well as an inspection problem. */
export class Alpha214PluginBundleRepository extends Alpha213PluginBundleRepository {
  protected override readonly wireProfile: PluginManagerWireProfile = {
    restartReason: true,
    alreadyInstalled: true,
  }
}
