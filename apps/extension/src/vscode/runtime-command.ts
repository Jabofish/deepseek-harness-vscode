import { spawn, execFile, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { RuntimeCommandOptions, RuntimeCommandResult } from './update-runtime.js'

/** Stream a mutation without execFile's output limit terminating a working npm install. */
export function streamRuntimeCommand(
  executable: string,
  args: readonly string[],
  options: RuntimeCommandOptions & { readonly cwd?: string },
): Promise<RuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const receive = (stream: 'stdout' | 'stderr', text: string): void => {
      if (stream === 'stdout') stdout = (stdout + text).slice(-options.maxBuffer)
      else stderr = (stderr + text).slice(-options.maxBuffer)
      try {
        options.onOutput?.(text, stream)
      } catch {
        /* A closed output panel cannot fail npm. */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stopOwnedCommand(child)
    }, options.timeout)
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      receive('stdout', decoders.stdout.end())
      receive('stderr', decoders.stderr.end())
      if (error !== undefined) reject(Object.assign(error, { stdout, stderr, timedOut, killed: timedOut }))
      else resolve({ stdout, stderr })
    }
    child.stdout?.on('data', (chunk: Buffer) => receive('stdout', decoders.stdout.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => receive('stderr', decoders.stderr.write(chunk)))
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => {
      finish(
        code === 0 && !timedOut
          ? undefined
          : Object.assign(new Error(timedOut ? 'npm installation timed out.' : 'npm installation failed.'), {
              code: timedOut ? 'ETIMEDOUT' : code,
              signal,
            }),
      )
    })
  })
}

/** Only the process/group created above is eligible for timeout cleanup. */
function stopOwnedCommand(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(
      executable,
      ['/pid', String(child.pid), '/T', '/F'],
      { windowsHide: true, timeout: 5_000 },
      (error) => {
        if (error !== null && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      },
    )
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** Respect npm/env routing; use VS Code's explicit proxy only as a fallback. */
export function runtimeNpmEnvironment(environment: NodeJS.ProcessEnv, proxy?: string): NodeJS.ProcessEnv {
  const result = { ...environment }
  const lookup = (name: string): string | undefined =>
    Object.entries(result).find(([key]) => key.toLowerCase() === name)?.[1]
  const npmProxy = Object.entries(result).some(
    ([name, value]) => /^npm_config_(?:https_)?proxy$/iu.test(name) && value !== undefined,
  )
  // npm reads HTTP(S)_PROXY, but does not read the commonly configured ALL_PROXY.
  const common = lookup('http_proxy') ?? lookup('all_proxy') ?? lookup('proxy')
  if (!npmProxy && common !== undefined && lookup('https_proxy') === undefined) result.HTTPS_PROXY = common
  if (!npmProxy && common !== undefined && lookup('http_proxy') === undefined) result.HTTP_PROXY = common
  const configured = Object.entries(result).some(
    ([name, value]) =>
      /^(?:https?_proxy|all_proxy|proxy|npm_config_(?:https_)?proxy)$/iu.test(name) && value !== undefined,
  )
  if (!configured && proxy !== undefined && proxy.trim() !== '') {
    result.HTTPS_PROXY = proxy
    result.HTTP_PROXY = proxy
  }
  return result
}
