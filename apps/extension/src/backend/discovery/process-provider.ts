import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BackendCandidate } from '@dsh-vscode/domain'

const execFileAsync = promisify(execFile)
const PROCESS_TIMEOUT_MS = 1_500
const OUTPUT_LIMIT = 128 * 1024

export async function runDiscoveryCommand(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await execFileAsync(executable, [...args], {
    shell: false,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: OUTPUT_LIMIT,
    windowsHide: true,
    ...(signal === undefined ? {} : { signal }),
  })
  return result.stdout
}

export function parseDshProcessCandidates(
  processOutput: string,
  listenerOutput: string,
): readonly BackendCandidate[] {
  const dshProcesses = new Map<number, string>()
  for (const line of processOutput.split(/\r?\n/)) {
    const pid = processId(line)
    if (pid === undefined || !isWebDshCommand(line)) continue
    dshProcesses.set(pid, line.slice(0, 1_024))
  }
  const candidates: BackendCandidate[] = []
  for (const listener of parseListeners(listenerOutput)) {
    const commandLine = dshProcesses.get(listener.pid)
    if (commandLine === undefined) continue
    candidates.push({
      endpoint: {
        host: listener.host,
        port: listener.port,
        baseUrl: `http://${listener.host}:${listener.port}`,
      },
      source: 'process-scan',
      pid: listener.pid,
      commandLine,
      confidence: 70,
    })
  }
  return candidates
}

function isWebDshCommand(line: string): boolean {
  const normalized = line.toLowerCase()
  const isDsh =
    normalized.includes('@deepseek-ai\\dsh') ||
    normalized.includes('@deepseek-ai/dsh') ||
    /(^|[\s"'])dsh(?:\.cmd)?(?:[\s"']|$)/i.test(line)
  if (!isDsh) return false
  return /(?:--profile\s+web|\bdsh(?:\.cmd)?\s+web\b)/i.test(line)
}

function processId(line: string): number | undefined {
  const windows = line.match(/,([0-9]+)\s*$/)
  const posix = line.match(/^\s*([0-9]+)(?:\s|$)/)
  const value = windows?.[1] ?? posix?.[1]
  if (value === undefined) return undefined
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function parseListeners(
  output: string,
): readonly { host: '127.0.0.1' | 'localhost'; port: number; pid: number }[] {
  const result: { host: '127.0.0.1' | 'localhost'; port: number; pid: number }[] = []
  for (const line of output.split(/\r?\n/)) {
    const pid = listenerPid(line)
    if (pid === undefined) continue
    const address = line.match(/(?:127\.0\.0\.1|localhost):(\d{1,5})\b/i)
    const dotted = line.match(/127\.0\.0\.1\.(\d{1,5})\b/)
    const port = Number(address?.[1] ?? dotted?.[1])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue
    result.push({
      host: address?.[0]?.toLowerCase().startsWith('localhost') ? 'localhost' : '127.0.0.1',
      port,
      pid,
    })
  }
  return result
}

function listenerPid(line: string): number | undefined {
  const explicit =
    line.match(/(?:pid=|\s)(\d+)\s*$/i)?.[1] ??
    line.match(/pid[=:](\d+)/i)?.[1] ??
    line.match(/^\S+\s+(\d+)\s/)?.[1]
  if (explicit === undefined) return undefined
  const pid = Number(explicit)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}
