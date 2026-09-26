import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { AppError, type BackendEndpoint } from '@dsh-vscode/domain'
import { runtimePathEntries } from '../backend/runtime-paths.js'
import type { SpawnedChild } from '../backend/process-supervisor.js'
import { resolveWindowsShim } from '../backend/windows-shim.js'

export function platform(): 'windows' | 'linux' | 'macos' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
}

export function endpointFromServerUrl(serverUrl: string | undefined): BackendEndpoint | undefined {
  if (serverUrl === undefined) return undefined
  try {
    const parsed = new URL(serverUrl)
    const host = parsed.hostname
    const port = Number(parsed.port)
    if (
      parsed.protocol !== 'http:' ||
      (host !== '127.0.0.1' && host !== 'localhost') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      return undefined
    return { host, port, baseUrl: `http://${host}:${port}` }
  } catch {
    return undefined
  }
}

export function runtimeEnvironment(overrides?: NodeJS.ProcessEnv, executable?: string): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...(overrides ?? {}) }
  const entries = extensionRuntimePathEntries(platform(), environment)
  const executableDirectory = executable === undefined ? undefined : path.dirname(executable)
  const prefix =
    executableDirectory === undefined || executableDirectory === '.' ? undefined : executableDirectory
  environment.PATH = [prefix, ...entries]
    .filter((entry): entry is string => entry !== undefined)
    .join(path.delimiter)
  return environment
}

export function windowsShimOptions(
  os: 'windows' | 'linux' | 'macos',
  environment: NodeJS.ProcessEnv,
): {
  readonly pathEntries: readonly string[]
  readonly processExecutable: string
} {
  return {
    pathEntries: extensionRuntimePathEntries(os, environment),
    processExecutable: process.execPath,
  }
}

export function extensionRuntimePathEntries(
  os: 'windows' | 'linux' | 'macos',
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  return runtimePathEntries(os, environment, os === 'windows' ? homedir() : undefined)
}
export function readTextFile(filePath: string): string {
  return readFileSync(filePath, 'utf8')
}
export function spawnManagedChild(
  executable: string,
  args: readonly string[],
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): SpawnedChild {
  const childEnvironment = { ...process.env, ...(environment ?? {}) }
  const resolved = resolveWindowsShim(
    executable,
    platform(),
    readTextFile,
    windowsShimOptions(platform(), childEnvironment),
  )
  const resolvedExecutable = resolved?.executable ?? executable
  const executableDirectory = path.dirname(resolvedExecutable)
  const prefix = executableDirectory === '.' ? undefined : executableDirectory
  childEnvironment.PATH = [prefix, ...extensionRuntimePathEntries(platform(), childEnvironment)]
    .filter((entry): entry is string => entry !== undefined)
    .join(path.delimiter)
  const child = spawn(
    resolved?.executable ?? executable,
    resolved ? [...resolved.prefixArgs, ...args] : [...args],
    {
      shell: false,
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
      env: childEnvironment,
    },
  )
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // A launch that never produced a process (missing executable, EACCES)
    // reports `error` and never `exit`. Resolve the exit contract so callers
    // stop waiting for a process that does not exist, and so the reason is not
    // raised as an unhandled event in the Extension Host.
    child.once('error', () => resolve({ code: -1, signal: null }))
  })
  return {
    pid: child.pid ?? -1,
    stdout: textStream(child.stdout),
    stderr: textStream(child.stderr),
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal)
    },
    exited,
  }
}

async function* textStream(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return
  for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}
export function readExtensionVersion(context: vscode.ExtensionContext): string {
  const packageJson = context.extension.packageJSON as unknown as { readonly version?: unknown }
  const version = packageJson.version
  return typeof version === 'string' && version.trim() !== '' ? version : 'unknown'
}
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath))
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw new AppError({
      code: 'EXPORT_FAILED',
      message: 'The export destination could not be inspected.',
      retryable: false,
      cause: error,
    })
  }
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'FileNotFound')
  )
}
