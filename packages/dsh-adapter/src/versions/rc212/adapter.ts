import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Rc211VersionAdapter } from '../rc211/adapter.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { Rc212EditorBridgeRepository } from './editor-bridge-repository.js'

/** dsh-v0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317.
 * Consumed Remote, Gateway, V4, tools and account contracts retain the rc.1 wire.
 * Web provider selection and Search / Fetch options arrive through settings.describe.
 */
export class Rc212VersionAdapter extends Rc211VersionAdapter {
  protected override createEditorBridgeRepository(
    transport: AlphaLoopbackApiClient,
  ): Rc212EditorBridgeRepository {
    return new Rc212EditorBridgeRepository(transport)
  }
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.2.1-rc.2',
    supportedVersion: '0.2.1-rc.2',
    protocolVersion: 'rc212',
    compatibilityPriority: 330,
    fallback: false,
  }
}
