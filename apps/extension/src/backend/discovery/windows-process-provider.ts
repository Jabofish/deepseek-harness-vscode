import type { BackendCandidate } from '@dsh-vscode/domain'
import { unimplemented } from '@dsh-vscode/domain'

import type { DiscoveryProvider } from './provider.js'

export class WindowsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'windows-process'

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    return unimplemented<Promise<readonly BackendCandidate[]>>('Windows running DSH discovery', [
      'query only local listening endpoints and process metadata using bounded PowerShell or native APIs',
      'identify dsh web command lines without reading unrelated process environment or secrets',
      'parse exact loopback ports and pids, then require protocol probing',
      'gracefully return no candidates when process inspection is unavailable or denied',
      `signal present ${String(signal !== undefined)}`,
    ])
  }
}
