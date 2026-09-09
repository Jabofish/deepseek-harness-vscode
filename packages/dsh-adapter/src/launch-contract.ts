import { normalizeDshVersion } from './contracts.js'

/**
 * DSH versions whose Web Profile explicitly exposes `--no-open`.
 *
 * rc.6 and rc.7 intentionally are not in this set: their Web Profile only
 * accepts the host/port/trusted-host flag family. Unknown versions also stay
 * out until their CLI contract is verified, because an optional flag must
 * never be allowed to prevent the managed process from starting.
 */
const WEB_NO_OPEN_VERSIONS = new Set([
  '0.1.0-rc.8',
  '0.1.1-rc.1',
  '0.1.1-rc.2',
  '0.1.2-rc.1',
  '0.1.2-alpha.1',
  '0.1.2-alpha.2',
  '0.1.2-alpha.3',
  '0.1.2-alpha.4',
  '0.1.2-alpha.5',
  '0.1.3-alpha.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1',
])

/**
 * Build the managed Web Profile argument vector for one DSH CLI version.
 *
 * The profile/host/port flags are the common launch contract. `--no-open` is
 * added only for versions whose upstream Web Profile declares it, preserving
 * the Extension Host-owned UI without making rc.6/rc.7 reject the launch.
 */
export function managedWebArguments(version: string, port: number): readonly string[] {
  const normalizedVersion = normalizeDshVersion(version)
  return [
    '--profile',
    'web',
    ...(normalizedVersion !== undefined && WEB_NO_OPEN_VERSIONS.has(normalizedVersion) ? ['--no-open'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
}
