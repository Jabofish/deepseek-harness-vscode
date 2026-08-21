import { Rc6VersionAdapter } from '../rc6/adapter.js'
import type { DshTransport } from '../../contracts.js'
import { Rc8CommandRepository } from '../../repositories/command-repository.js'

/** rc.8 adds the `home` host-describe field and new durable event families. */
export class Rc8VersionAdapter extends Rc6VersionAdapter {
  public override readonly id = 'dsh-0.1.0-rc.8'
  public override readonly supportedVersion = '0.1.0-rc.8'
  public override readonly fallback = false
  public override readonly protocolVersion = 'rc8'
  protected override readonly requiresHome = true

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === undefined || version === this.supportedVersion || !isPinnedLegacy(version)
  }

  protected override createCommandRepository(transport: DshTransport): Rc8CommandRepository {
    return new Rc8CommandRepository(transport)
  }
}

function isPinnedLegacy(version: string): boolean {
  return version === '0.1.0-rc.6' || version === '0.1.0-rc.7'
}
