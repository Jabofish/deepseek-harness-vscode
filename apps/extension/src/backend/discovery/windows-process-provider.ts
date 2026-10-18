import type { BackendCandidate, BackendEndpoint } from '@dsh-vscode/domain'

import { discoveryCancelled, isDiscoveryCancellation, type DiscoveryProvider } from './provider.js'
import {
  parseDshProcessCandidates,
  resolveEndpointProcesses,
  resolveDshProcessRuntimeVersions,
  runDiscoveryCommand,
} from './process-provider.js'

type DiscoveryCommand = (executable: string, args: readonly string[], signal?: AbortSignal) => Promise<string>

const WMIC_PROCESS_ARGS = [
  'process',
  'where',
  "CommandLine like '%dsh%'",
  'get',
  'CommandLine,ProcessId',
  '/format:csv',
] as const
const POWERSHELL_PROCESS_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  windowsProcessScript("CommandLine LIKE '%dsh%'"),
] as const

export class WindowsProcessDiscoveryProvider implements DiscoveryProvider {
  public readonly id = 'windows-process'
  public readonly phase = 'fallback' as const

  public constructor(
    private readonly runCommand: DiscoveryCommand = runDiscoveryCommand,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  public async discoverEndpoints(
    endpoints: readonly BackendEndpoint[],
    signal?: AbortSignal,
    processIds?: readonly number[],
  ): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) throw discoveryCancelled(signal.reason)
    if (this.platform !== 'win32') return []
    const abort = new AbortController()
    const lookupSignal = signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal])
    const hints = processIds?.filter((pid) => Number.isSafeInteger(pid) && pid > 0) ?? []
    // Query hinted PIDs alongside listeners, then require a current listener,
    // current DSH argv and current package metadata. A recycled PID cannot
    // promote the saved hint to a verified runtime identity.
    const hintedProcesses =
      hints.length === 0
        ? undefined
        : runWindowsProcessListing(this.runCommand, lookupSignal, hints).catch(() => '')
    try {
      const listeners = await this.runCommand('netstat.exe', ['-ano', '-p', 'tcp'], signal)
      return await resolveEndpointProcesses(
        endpoints,
        listeners,
        (pids) =>
          hintedProcesses !== undefined && pids.every((pid) => hints.includes(pid))
            ? hintedProcesses
            : runWindowsProcessListing(this.runCommand, signal, pids),
        signal,
      )
    } catch (error) {
      if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
      return []
    } finally {
      abort.abort()
    }
  }

  public discover(signal?: AbortSignal): Promise<readonly BackendCandidate[]> {
    if (signal?.aborted === true) return Promise.reject(discoveryCancelled(signal.reason))
    if (this.platform !== 'win32') return Promise.resolve([])
    return Promise.all([
      runWindowsProcessListing(this.runCommand, signal),
      this.runCommand('netstat.exe', ['-ano', '-p', 'tcp'], signal),
    ])
      .then(async ([processes, listeners]) => {
        const candidates = await resolveDshProcessRuntimeVersions(
          parseDshProcessCandidates(processes, listeners),
        )
        if (signal?.aborted === true) throw discoveryCancelled(signal.reason)
        return candidates
      })
      .catch((error: unknown) => {
        if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
        return []
      })
  }
}

/**
 * Windows 11 can omit WMIC. Emit escaped CSV from the WMI fallback so commas
 * and quotes in command lines survive parsing. The command uses fixed argv and
 * never interpolates user input.
 */
export async function runWindowsProcessListing(
  runCommand: DiscoveryCommand = runDiscoveryCommand,
  signal?: AbortSignal,
  pids?: readonly number[],
): Promise<string> {
  const selectedPids = pids?.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (selectedPids !== undefined && selectedPids.length === 0) return ''
  const filter = selectedPids?.map((pid) => `ProcessId = ${pid}`).join(' OR ')
  try {
    const output = await runCommand(
      'wmic.exe',
      filter === undefined
        ? WMIC_PROCESS_ARGS
        : ['process', 'where', filter, 'get', 'CommandLine,ProcessId', '/format:csv'],
      signal,
    )
    if (output.trim() !== '') return output
  } catch (error: unknown) {
    if (isDiscoveryCancellation(error, signal)) throw discoveryCancelled(signal?.reason ?? error)
  }
  return runCommand(
    'powershell.exe',
    filter === undefined
      ? POWERSHELL_PROCESS_ARGS
      : [...POWERSHELL_PROCESS_ARGS.slice(0, -1), windowsProcessScript(filter)],
    signal,
  )
}

function windowsProcessScript(filter: string): string {
  // The filter is fixed text or validated numeric PIDs, never caller text.
  // Native WMI avoids loading the CIM module on the critical startup path.
  return `$ErrorActionPreference='Stop'; $query=$null; $rows=$null; try { $query=[wmisearcher]"SELECT CommandLine,ProcessId FROM Win32_Process WHERE ${filter}"; $rows=$query.Get(); $rows | Select-Object CommandLine,ProcessId | ConvertTo-Csv -NoTypeInformation } finally { if ($null -ne $rows) { $rows.Dispose() }; if ($null -ne $query) { $query.Dispose() } }`
}
