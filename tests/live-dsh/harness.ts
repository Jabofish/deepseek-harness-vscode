import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {
  DshProcessSupervisor,
  type SpawnedChild,
} from '../../apps/extension/src/backend/process-supervisor.js'
import { resolveWindowsShim } from '../../apps/extension/src/backend/windows-shim.js'
import { VersionedBackendFactory } from '../../packages/dsh-adapter/src/backend-factory.js'
import type { ExportFileSystem } from '../../packages/dsh-adapter/src/repositories/export-repository.js'
import { managedWebArguments } from '../../packages/dsh-adapter/src/launch-contract.js'
import { VersionedBackendProbe } from '../../packages/dsh-adapter/src/probe.js'
import type { DshBackend } from '../../packages/domain/src/backend.js'
import type { BackendEndpoint, ManagedProcessHandle } from '../../packages/domain/src/runtime.js'
import { Rc151VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc151/adapter.js'
import { Rc152VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc152/adapter.js'
import { Rc153VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc153/adapter.js'
import { Alpha161VersionAdapter } from '../../packages/dsh-adapter/src/versions/alpha161/adapter.js'
import { Alpha162VersionAdapter } from '../../packages/dsh-adapter/src/versions/alpha162/adapter.js'
import { Alpha171VersionAdapter } from '../../packages/dsh-adapter/src/versions/alpha171/adapter.js'
import { Alpha172VersionAdapter } from '../../packages/dsh-adapter/src/versions/alpha172/adapter.js'
import { Rc171VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc171/adapter.js'
import { Rc172VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc172/adapter.js'
import { acquireManagedRuntimeScope, type ManagedRuntimeScope } from './runtime-scope.js'
import { resolveLiveRuntime } from './runtime.js'

export const DEFAULT_RUNTIME_VERSION = '0.1.5-rc.3'
export const LIVE_TIMEOUT_MS = 90_000

/** Read-only history probes require an explicitly seeded, disposable profile. */
export function hasLiveHistoryFixture(): boolean {
  return liveHistoryFixtureHome() !== undefined
}

export function requireLiveHistoryFixtureHome(): string {
  const home = liveHistoryFixtureHome()
  if (home === undefined) throw new Error('This live DSH probe requires a history fixture home.')
  return home
}

export interface LiveRuntimeSnapshot {
  readonly executable: string
  readonly version: string
  readonly port: number
  readonly workspace: string
  readonly steps: readonly string[]
}

export interface ManagedLiveRuntime {
  readonly backend: DshBackend
  readonly snapshot: LiveRuntimeSnapshot
  readonly steps: string[]
  /** Close the connection, stop the owned process and remove the temp workspace. */
  stop(): Promise<void>
}

/** Retry owned-child cleanup before releasing any resources the child may use. */
export async function startManagedProcessWithCleanup<T>(
  start: () => Promise<T>,
  disposeSupervisor: () => Promise<void>,
  cleanupScope: () => Promise<void>,
): Promise<T> {
  try {
    return await start()
  } catch (error) {
    try {
      await disposeSupervisor()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'The managed DSH launch failed and its process cleanup could not be confirmed.',
        { cause: cleanupError },
      )
    }
    try {
      await cleanupScope()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'The managed DSH launch cleanup failed.', {
        cause: cleanupError,
      })
    }
    throw error
  }
}

/**
 * Start an isolated, extension-owned DSH exactly as the Extension Host does and
 * return a connected backend. Only the process started here is signalled; an
 * external DSH is never touched.
 *
 * Explicit options win; otherwise `DSH_LIVE_RUNTIME` and
 * `DSH_LIVE_RUNTIME_VERSION` select the executable and the adapter hint so that
 * every live spec reads the same environment instead of silently probing a
 * newer binary under the pinned default version.
 */
export async function startManagedRuntime(options?: {
  readonly requestedRuntime?: string
  readonly runtimeVersion?: string
  /** A fixture-owned isolated home used when the live test seeds DSH state. */
  readonly dshHome?: string
  /** Remove a test-created DSH home only after the managed process is confirmed stopped. */
  readonly removeDshHomeOnStop?: boolean
  readonly exportFileSystem?: ExportFileSystem
}): Promise<ManagedLiveRuntime> {
  const runtimeExecutable = resolveLiveRuntime(
    options?.requestedRuntime?.trim() || process.env.DSH_LIVE_RUNTIME?.trim() || 'dsh',
  )
  const runtimeVersion =
    options?.runtimeVersion?.trim() || process.env.DSH_LIVE_RUNTIME_VERSION?.trim() || DEFAULT_RUNTIME_VERSION
  const port = await freeLoopbackPort()
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-'))
  const launchArguments = managedWebArguments(runtimeVersion, port)
  const steps: string[] = []
  const endpointCookie: { value: string | undefined } = { value: undefined }
  const supervisor = new DshProcessSupervisor({
    spawn: spawnManagedChild,
    managedPort: () => port,
    workingDirectory: () => workspace,
    onReadyEndpoint: async (endpoint, launchUrl) => {
      if (launchUrl === undefined) return
      const response = await globalThis.fetch(launchUrl, { method: 'GET', redirect: 'manual' })
      const headers = response.headers as Headers & { getSetCookie?: () => string[] }
      const setCookies = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']
      endpointCookie.value = setCookies
        .map((value) => value.split(';', 1)[0]?.trim() ?? '')
        .find((value) => /^[^=;\s]+=[^;\r\n]+$/u.test(value))
      steps.push(
        `login ${endpoint.baseUrl} status=${response.status} cookie=${endpointCookie.value === undefined ? 'missing' : 'exchanged'}`,
      )
    },
  })
  const lockWaitStart = Date.now()
  let runtimeScope: Awaited<ReturnType<typeof acquireManagedRuntimeScope>>
  try {
    runtimeScope = await acquireManagedRuntimeScope(options?.dshHome, {
      removeRequestedHome: options?.removeDshHomeOnStop === true,
    })
  } catch (error) {
    await rm(workspace, { recursive: true, force: true })
    throw error
  }
  // The live spec files run one after another (`vitest.config.ts`), so this
  // lock is the cross-run guard: a second shell starting its own managed DSH
  // while this one is live would blow the supervisor's 15s readiness budget.
  // The scope acquires the lock before overriding the process-wide DSH_HOME.
  if (Date.now() - lockWaitStart > 1_000) steps.push(`lock wait ${Date.now() - lockWaitStart}ms`)
  steps.push(`launch ${runtimeExecutable} ${launchArguments.join(' ')}`)
  const started = await startManagedProcessWithCleanup(
    () =>
      supervisor.start({
        executable: runtimeExecutable,
        version: runtimeVersion,
        supported: true,
        compatibility: 'known',
        source: 'path',
      }),
    () => supervisor.dispose(),
    () => cleanupRuntimeScope(workspace, runtimeScope),
  )
  const snapshot: LiveRuntimeSnapshot = {
    executable: runtimeExecutable,
    version: runtimeVersion,
    port,
    workspace,
    steps,
  }
  try {
    assertLoopbackEndpoint(started.endpoint)
    steps.push(`managed start pid=${started.pid} endpoint=${started.endpoint.baseUrl}`)

    const adapters = [
      new Rc172VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Rc171VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Alpha172VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Alpha171VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Alpha162VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Alpha161VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Rc153VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Rc152VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
      new Rc151VersionAdapter(adapterOptions(endpointCookie, options?.exportFileSystem)),
    ]
    const probe = new VersionedBackendProbe(adapters, { fetch: globalThis.fetch })
    const connected = await probe.probe({
      endpoint: started.endpoint,
      source: 'configured',
      runtimeVersion,
      confidence: 1,
    })
    if (connected === undefined) throw new Error('the real DSH endpoint did not answer the probe')
    steps.push(
      `probe dsh=${connected.capabilities.dshVersion} protocol=${connected.capabilities.protocolVersion} adapter=${connected.capabilities.adapterId ?? 'unset'} mode=${connected.capabilities.compatibilityMode ?? 'unset'}`,
    )
    const backend = await new VersionedBackendFactory(adapters).connect(connected)
    return {
      backend,
      snapshot,
      steps,
      stop: async () => {
        await backend.close().catch(() => undefined)
        await stopManagedProcessWithRetry(started, () => supervisor.dispose())
        await cleanupRuntimeScope(workspace, runtimeScope)
        steps.push('managed process stopped; runtime scope released')
      },
    }
  } catch (error) {
    try {
      await stopManagedProcessWithRetry(started, () => supervisor.dispose())
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'The managed DSH probe failed and its process cleanup could not be confirmed.',
        { cause: cleanupError },
      )
    }
    try {
      await cleanupRuntimeScope(workspace, runtimeScope)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'The managed DSH probe cleanup failed.', {
        cause: cleanupError,
      })
    }
    throw error
  }
}

/** Preserve the supervisor's retryable handle when its first stop attempt fails. */
export async function stopManagedProcessWithRetry(
  started: Pick<ManagedProcessHandle, 'stop'>,
  disposeSupervisor: () => Promise<void>,
): Promise<void> {
  try {
    await started.stop()
  } catch (stopError) {
    try {
      await disposeSupervisor()
    } catch (cleanupError) {
      throw new AggregateError(
        [stopError, cleanupError],
        'The managed DSH process could not be stopped after a cleanup retry.',
        { cause: cleanupError },
      )
    }
  }
}

async function cleanupRuntimeScope(workspace: string, runtimeScope: ManagedRuntimeScope): Promise<void> {
  const failures: unknown[] = []
  try {
    await rm(workspace, { recursive: true, force: true })
  } catch (error) {
    failures.push(error)
  }
  try {
    await runtimeScope.release()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, 'The managed DSH workspace and runtime scope cleanup failed.', {
      cause: failures[0],
    })
}

export function adapterOptions(
  cookie: { readonly value: string | undefined },
  exportFileSystem?: ExportFileSystem,
): ConstructorParameters<typeof Rc151VersionAdapter>[0] {
  return {
    requestTimeoutMs: 10_000,
    retryPolicy: { maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 },
    fetch: globalThis.fetch,
    samePath: (left: string, right: string) => path.resolve(left) === path.resolve(right),
    authCookie: () => cookie.value,
    ...(exportFileSystem === undefined ? {} : { exportFileSystem }),
  }
}

function liveHistoryFixtureHome(): string | undefined {
  const home = process.env.DSH_LIVE_HISTORY_FIXTURE_HOME?.trim()
  return home === undefined || home === '' ? undefined : home
}

export function assertLoopbackEndpoint(endpoint: BackendEndpoint): void {
  // Widened on purpose: this guards a value that can arrive from a cast or a
  // parsed handshake, not only from the domain type.
  const host: string = endpoint.host
  if (host !== '127.0.0.1' && host !== 'localhost')
    throw new Error(`the managed runtime must stay on loopback, got ${host}`)
  if (endpoint.baseUrl !== `http://${host}:${endpoint.port}`)
    throw new Error(`the managed endpoint must match its loopback host and port, got ${endpoint.baseUrl}`)
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
    process.platform === 'win32' ? 'windows' : 'linux',
    (filePath) => readFileSync(filePath, 'utf8'),
    { nodeExecutable: process.execPath },
  )
  const child: ChildProcess = spawnChild(
    resolved?.executable ?? executable,
    resolved === undefined ? [...args] : [...resolved.prefixArgs, ...args],
    {
      shell: false,
      windowsHide: true,
      ...(cwd === undefined ? {} : { cwd }),
      env: childEnvironment,
    },
  )
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    // Mirror the Extension Host spawner: a failed launch reports `error` and
    // never `exit`, which must not surface as an unhandled event here.
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

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('the port probe did not receive a TCP port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

export function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Socket()
    probe.setTimeout(1_000)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('timeout', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => {
      probe.destroy()
      resolve(false)
    })
    probe.connect(port, '127.0.0.1')
  })
}
