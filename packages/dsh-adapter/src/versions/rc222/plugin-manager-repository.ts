import { AppError, type PluginInstallOptions } from '@dsh-vscode/domain'
import { isDshPackageVersion } from '../../contracts.js'
import { Alpha222PluginBundleRepository } from '../alpha222/plugin-manager-repository.js'
import type { PluginManagerWireProfile } from '../rc172/plugin-manager-repository.js'

export class Rc222PluginBundleRepository extends Alpha222PluginBundleRepository {
  public readonly supportsExpectedPackage = true
  protected override readonly wireProfile: PluginManagerWireProfile = {
    restartReason: true,
    alreadyInstalled: true,
    unsupportedPlatform: true,
    unexpectedPackage: true,
  }

  protected override mapInstallOptions(options: PluginInstallOptions): Readonly<Record<string, unknown>> {
    const inherited = super.mapInstallOptions(options)
    if (options.expected === undefined) return inherited
    const { name, version } = options.expected
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u.test(name) ||
      name.length > 214 ||
      !isDshPackageVersion(version)
    )
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'Invalid expected plugin package.',
        retryable: false,
      })
    return { ...inherited, expected: { name, version } }
  }
}
