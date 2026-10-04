import { AppError, type PluginBundleChangeResult } from '@dsh-vscode/domain'

import { isDshPackageVersion } from '../../contracts.js'
import { Rc172PluginBundleRepository } from '../rc172/plugin-manager-repository.js'

/** alpha.1 reports the manifest version actually installed, including recovered results. */
export class Alpha211PluginBundleRepository extends Rc172PluginBundleRepository {
  protected override mapInstallResult(value: unknown, expectedSpec: string): PluginBundleChangeResult {
    return withInstalledVersion(super.mapInstallResult(value, expectedSpec), value)
  }

  protected override mapInstallRecoveryResult(value: unknown): PluginBundleChangeResult {
    return withInstalledVersion(super.mapInstallRecoveryResult(value), value)
  }
}

function withInstalledVersion(result: PluginBundleChangeResult, value: unknown): PluginBundleChangeResult {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version === undefined)
    return result
  if (
    result.bundle === undefined ||
    typeof value.version !== 'string' ||
    value.version.length > 128 ||
    !isDshPackageVersion(value.version)
  ) {
    throw new AppError({
      code: 'PROTOCOL_ERROR',
      message: 'DSH returned a malformed installed bundle version.',
      retryable: false,
    })
  }
  // Bundle source may contain an absolute path or private URL and is never projected.
  return { ...result, version: value.version }
}
