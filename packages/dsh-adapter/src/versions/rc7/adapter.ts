import { Rc6VersionAdapter } from '../rc6/adapter.js'

/** rc.7 retained the rc.6 Host API wire shape; keep its identity explicit. */
export class Rc7VersionAdapter extends Rc6VersionAdapter {
  public override readonly id = 'dsh-0.1.0-rc.7'
  public override readonly supportedVersion = '0.1.0-rc.7'
  public override readonly fallback = false
  public override readonly protocolVersion = 'rc7'

  protected override acceptsRuntimeHint(version: string | undefined): boolean {
    return version === this.supportedVersion
  }
}
