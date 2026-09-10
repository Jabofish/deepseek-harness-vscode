import { isKnownDshVersion, normalizeDshVersion } from './contracts.js'

/**
 * Early DSH Web Profiles that predate the `--no-open` option.
 *
 * Every later known Web Profile gets `--no-open` by default. Unknown versions
 * stay out until their CLI contract is verified, because an optional flag must
 * never be allowed to prevent the managed process from starting.
 */
const WEB_NO_OPEN_UNSUPPORTED_VERSIONS = new Set([
  '0.0.1-rc.1',
  '0.0.1-rc.2',
  '0.0.1-rc.5',
  '0.1.0-rc.2',
  '0.1.0-rc.3',
  '0.1.0-rc.6',
  '0.1.0-rc.7',
])

/**
 * Build the managed Web Profile argument vector for one DSH CLI version.
 *
 * The profile/host/port flags are the common launch contract. `--no-open` is
 * the default for every known release after the early Web Profiles above.
 * Unknown versions remain conservative until their CLI contract is verified.
 */
export function managedWebArguments(version: string, port: number): readonly string[] {
  const normalizedVersion = normalizeDshVersion(version)
  const useNoOpen =
    normalizedVersion !== undefined &&
    isKnownDshVersion(normalizedVersion) &&
    !WEB_NO_OPEN_UNSUPPORTED_VERSIONS.has(normalizedVersion)
  return [
    '--profile',
    'web',
    ...(useNoOpen ? ['--no-open'] : []),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]
}
