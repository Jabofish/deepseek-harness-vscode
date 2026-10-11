import { AppError, type PluginInstallOptions, type PluginManagerBundle } from '@dsh-vscode/domain'

import { recordOrUndefined } from '../../repositories/shared/guards.js'
import { isDshPackageVersion } from '../../contracts.js'
import { Alpha211PluginBundleRepository } from '../alpha211/plugin-manager-repository.js'

/** Exact alpha.2 official on-demand inventory; sources never become public DTOs. */
export class Alpha212PluginBundleRepository extends Alpha211PluginBundleRepository {
  protected override mapBundleInfo(value: unknown): PluginManagerBundle {
    const bundle = super.mapBundleInfo(value)
    const data = recordOrUndefined(value)
    if (
      data === undefined ||
      typeof data.official !== 'boolean' ||
      (data.availability !== 'installation' &&
        data.availability !== 'profile' &&
        data.availability !== 'missing')
    )
      throw malformed()
    const target = data.installTarget === undefined ? undefined : recordOrUndefined(data.installTarget)
    if (
      data.installTarget !== undefined &&
      (target === undefined ||
        !data.official ||
        typeof target.spec !== 'string' ||
        target.spec.trim() === '' ||
        target.spec.length > 4_096 ||
        target.spec.includes('\0') ||
        typeof target.version !== 'string' ||
        target.version.length > 128 ||
        !isDshPackageVersion(target.version))
    )
      throw malformed()
    return {
      ...bundle,
      official: data.official,
      availability: data.availability,
      ...(target === undefined
        ? {}
        : { installTarget: { spec: target.spec as string, version: target.version as string } }),
    }
  }

  protected override mapInstallOptions(options: PluginInstallOptions): Readonly<Record<string, unknown>> {
    if (options.saveExact !== undefined && typeof options.saveExact !== 'boolean') throw malformed()
    return options.saveExact === undefined ? {} : { saveExact: options.saveExact }
  }
}

function malformed(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed official bundle contract.',
    retryable: false,
  })
}
