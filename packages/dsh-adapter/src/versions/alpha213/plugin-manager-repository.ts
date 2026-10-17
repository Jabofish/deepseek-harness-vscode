import { Alpha212PluginBundleRepository } from '../alpha212/plugin-manager-repository.js'
import type { PluginManagerWireProfile } from '../rc172/plugin-manager-repository.js'

/** Restart facts apply to every mutation, including same-id install recovery. */
export class Alpha213PluginBundleRepository extends Alpha212PluginBundleRepository {
  protected override readonly wireProfile: PluginManagerWireProfile = { restartReason: true }
}
