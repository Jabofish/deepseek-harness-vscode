import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BackendCandidate } from '@dsh-vscode/domain'
import { DSH_PACKAGE_NAME, isDshPackageVersion } from '@dsh-vscode/dsh-adapter'

const execFileAsync = promisify(execFile)
const PROCESS_TIMEOUT_MS = 1_500
const OUTPUT_LIMIT = 128 * 1024
const PACKAGE_MANIFEST_LIMIT = 32 * 1024

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
    if (pid === undefined) continue
    const commandLine = extractCommandLine(line)
    if (!isWebDshCommand(commandLine)) continue
    dshProcesses.set(pid, commandLine.slice(0, 1_024))
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

type PackageManifestReader = (manifestPath: string) => Promise<string>

/**
 * Resolve runtime identity only from package metadata adjacent to the exact
 * CLI entry point in a process that already owns a confirmed loopback listener.
 */
export async function resolveDshProcessRuntimeVersions(
  candidates: readonly BackendCandidate[],
  readManifest: PackageManifestReader = readDshPackageManifest,
): Promise<readonly BackendCandidate[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.source !== 'process-scan') return candidate
      const unverified = withoutRuntimeVersionEvidence(candidate)
      if (candidate.pid === undefined || candidate.commandLine === undefined) return unverified
      const manifestPath = dshManifestPath(candidate.commandLine)
      if (manifestPath === undefined) return unverified
      try {
        const parsed: unknown = JSON.parse(await readManifest(manifestPath))
        if (typeof parsed !== 'object' || parsed === null) return unverified
        const record = parsed as Record<string, unknown>
        const version = record.version
        if (record.name !== DSH_PACKAGE_NAME || typeof version !== 'string' || !isDshPackageVersion(version))
          return unverified
        return { ...unverified, runtimeVersion: version, runtimeVersionEvidence: 'process-manifest' }
      } catch {
        // A missing, unreadable, or malformed package manifest is not identity evidence.
        return unverified
      }
    }),
  )
}

function withoutRuntimeVersionEvidence(candidate: BackendCandidate): BackendCandidate {
  const { runtimeVersion: ignoredVersion, runtimeVersionEvidence: ignoredEvidence, ...unverified } = candidate
  void ignoredVersion
  void ignoredEvidence
  return unverified
}

async function readDshPackageManifest(manifestPath: string): Promise<string> {
  const handle = await open(manifestPath, 'r')
  try {
    const details = await handle.stat()
    if (!details.isFile() || details.size > PACKAGE_MANIFEST_LIMIT)
      throw new Error('The DSH package manifest is not a small regular file.')
    const contents = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(contents, 'utf8') > PACKAGE_MANIFEST_LIMIT)
      throw new Error('The DSH package manifest exceeds the allowed size.')
    return contents
  } finally {
    await handle.close()
  }
}

function dshManifestPath(commandLine: string): string | undefined {
  const tokens = commandLineTokens(commandLine)
  if (tokens === undefined) return undefined
  const manifests = new Map<string, string>()
  for (const [index, token] of tokens.entries()) {
    // Supported upstream CLI launches place the package bin in argv[0] or
    // argv[1]; later occurrences could be an option value or user argument.
    if (index > 1) continue
    const manifestPath = dshManifestPathFromToken(token)
    if (manifestPath === undefined) continue
    const windowsPath = path.win32.isAbsolute(token) && /^[A-Za-z]:[\\/]/u.test(token)
    const key = windowsPath ? manifestPath.toLowerCase() : manifestPath
    manifests.set(key, manifestPath)
  }
  return manifests.size === 1 ? [...manifests.values()][0] : undefined
}

function dshManifestPathFromToken(token: string): string | undefined {
  const windowsPath = path.win32.isAbsolute(token) && /^[A-Za-z]:[\\/]/u.test(token)
  const uncPath = path.win32.isAbsolute(token) && token.startsWith('\\\\')
  const posixPath = !windowsPath && !uncPath && path.posix.isAbsolute(token)
  if (!windowsPath && !uncPath && !posixPath) return undefined
  const pathApi = windowsPath || uncPath ? path.win32 : path.posix
  const normalized = pathApi.normalize(token)
  const suffixMatches =
    windowsPath || uncPath
      ? /(?:^|\\)node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js$/iu.test(normalized)
      : /(?:^|\/)node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/u.test(normalized)
  if (!suffixMatches) return undefined
  const packageRoot = pathApi.dirname(pathApi.dirname(normalized))
  return pathApi.join(packageRoot, 'package.json')
}

function commandLineTokens(commandLine: string): readonly string[] | undefined {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let tokenStarted = false
  for (const character of commandLine) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else token += character
      tokenStarted = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      tokenStarted = true
    } else if (character === ' ' || character === '\t') {
      if (tokenStarted) tokens.push(token)
      token = ''
      tokenStarted = false
    } else {
      token += character
      tokenStarted = true
    }
  }
  if (quote !== undefined) return undefined
  if (tokenStarted) tokens.push(token)
  return tokens
}

function extractCommandLine(processRow: string): string {
  const csv = parseCsvRow(processRow)
  if (csv !== undefined && csv.length >= 2 && /^\d+$/u.test(csv.at(-1) ?? '')) return csv.at(-2) ?? processRow
  const posix = processRow.match(/^\s*\d+\s+(.+)$/u)
  if (posix?.[1] !== undefined) return posix[1]
  const windows = processRow.match(/^(.*),"?\d+"?\s*$/u)
  return windows?.[1] ?? processRow
}

function parseCsvRow(value: string): readonly string[] | undefined {
  const fields: string[] = []
  let field = ''
  let quoted = false
  let closedQuote = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quoted) {
      if (character === '"') {
        if (value[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
          closedQuote = true
        }
      } else if (character !== undefined) field += character
      continue
    }
    if (closedQuote) {
      if (character !== ',') return undefined
      fields.push(field)
      field = ''
      closedQuote = false
      continue
    }
    if (character === ',') {
      fields.push(field)
      field = ''
    } else if (character === '"' && field === '') quoted = true
    else if (character !== undefined) field += character
  }
  if (quoted) return undefined
  fields.push(field)
  return fields
}

function isWebDshCommand(line: string): boolean {
  const tokens = commandLineTokens(line)
  if (tokens === undefined || tokens.length === 0) return false
  const binIndex = tokens.findIndex(
    (token, index) => index <= 1 && dshManifestPathFromToken(token) !== undefined,
  )
  const hasPackageCli = binIndex >= 0 && dshManifestPath(line) !== undefined
  const executable = tokens[0] ?? ''
  const isDshShim = /(?:^|[\\/])dsh(?:\.cmd)?$/iu.test(executable)
  if (!hasPackageCli && !isDshShim) return false
  const hasWebProfile = tokens.some((token, index) => token === '--profile' && tokens[index + 1] === 'web')
  const shorthandIndex = isDshShim ? 0 : binIndex
  return hasWebProfile || (shorthandIndex >= 0 && tokens[shorthandIndex + 1] === 'web')
}

function processId(line: string): number | undefined {
  const windows = line.match(/,"?([0-9]+)"?\s*$/)
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
    if (!isTcpListener(line)) continue
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

function isTcpListener(line: string): boolean {
  return (
    /^\s*LISTEN(?:\s|$)/iu.test(line) ||
    /^\s*TCP\b.*\bLISTENING\b/iu.test(line) ||
    /\bTCP\b.*\(\s*LISTEN\s*\)\s*$/iu.test(line)
  )
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
