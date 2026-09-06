import type { BackendCandidate } from '@dsh-vscode/domain'

import { discoveryCancelled, isDiscoveryCancellation, type DiscoveryProvider } from './provider.js'
import { parseDshProcessCandidates, runDiscoveryCommand } from './process-provider.js'

type DiscoveryCommand = (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<string>

const WMIC_PROCESS_ARGS = ['process', 'get', 'CommandLine,ProcessId', '/format:csv'] as const
const POWERSHELL_PROCESS_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "$ErrorActionPreference='Stop'; Get-CimInstance -ClassName Win32_Process | ForEach-Object { if ($null -ne $_.CommandLine) { '{0},{1}' -f $_.CommandLine, $_.ProcessId } }",
] as const

export class WindowsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'windows-process'
  public readonly phase = 'fallback' as const

  public constructor(private readonly runCommand: DiscoveryCommand = runDiscoveryCommand) {}

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (process.platform !== 'win32') return Promise.resolve([])
    return Promise.all([
      runWindowsProcessListing(this.runCommand, signal),
      this.runCommand('netstat.exe', ['-ano'], signal),
    ])
      .then(([processes, listeners]) => parseDshProcessCandidates(processes, listeners))
      .catch((error: unknown) => {
        if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
        return []
      })
  }
}

/**
 * Windows 11 can omit WMIC. Keep the old parser-compatible output shape, but
 * obtain the process list through the supported CIM cmdlet without invoking a
 * shell or interpolating any user input.
 */
export async function runWindowsProcessListing(
  runCommand: DiscoveryCommand = runDiscoveryCommand,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const output = await runCommand('wmic.exe', WMIC_PROCESS_ARGS, signal)
    if (output.trim() !== '') return output
  } catch (error: unknown) {
    if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
  }
  return runCommand('powershell.exe', POWERSHELL_PROCESS_ARGS, signal)
}
