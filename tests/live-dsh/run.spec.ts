import { spawn as spawnChild, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DshProcessSupervisor,
  type SpawnedChild,
} from '../../apps/extension/src/backend/process-supervisor.js'
import { resolveWindowsShim } from '../../apps/extension/src/backend/windows-shim.js'
import { VersionedBackendFactory } from '../../packages/dsh-adapter/src/backend-factory.js'
import { managedWebArguments } from '../../packages/dsh-adapter/src/launch-contract.js'
import { VersionedBackendProbe } from '../../packages/dsh-adapter/src/probe.js'
import { Rc151VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc151/adapter.js'
import { Rc152VersionAdapter } from '../../packages/dsh-adapter/src/versions/rc152/adapter.js'
import type { BackendEndpoint } from '../../packages/domain/src/runtime.js'

const DEFAULT_RUNTIME_VERSION = '0.1.5-rc.1'
const LIVE_TIMEOUT_MS = 90_000

/**
 * Live DSH evidence run for the connection story: the real managed launch
 * contract, the real versioned probe and the real adapter for the running
 * build, against a DSH the test itself starts and stops.
 *
 * Opt-in because it needs an installed DSH and binds a loopback port:
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME = 'C:\path\to\dsh.cmd'      # defaults to `dsh` on PATH
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'      # defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/run.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never
 * touched, and the teardown asserts the loopback port is released.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH connection smoke', () => {
  it(
    'starts the managed web profile, probes it, reads sessions and releases the port',
    async () => {
      const runtimeExecutable = process.env.DSH_LIVE_RUNTIME?.trim() || 'dsh'
      const runtimeVersion = process.env.DSH_LIVE_RUNTIME_VERSION?.trim() || DEFAULT_RUNTIME_VERSION
      const port = await freeLoopbackPort()
      const workspace = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-smoke-'))
      const steps: string[] = []
      let handle: { readonly stop: (signal?: AbortSignal) => Promise<void> } | undefined
      // The managed web profile authorizes its RPC surface with the cookie
      // exchanged from the launch URL, exactly as the Extension Host does.
      const endpointCookie: { value: string | undefined } = { value: undefined }
      try {
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
        steps.push(`launch ${runtimeExecutable} ${managedWebArguments(runtimeVersion, port).join(' ')}`)
        const started = await supervisor.start({
          executable: runtimeExecutable,
          version: runtimeVersion,
          supported: true,
          compatibility: 'known',
          source: 'path',
        })
        handle = started
        assertLoopbackEndpoint(started.endpoint)
        steps.push(`managed start pid=${started.pid} endpoint=${started.endpoint.baseUrl}`)

        const adapters = [
          new Rc152VersionAdapter(adapterOptions(endpointCookie)),
          new Rc151VersionAdapter(adapterOptions(endpointCookie)),
        ]
        const probe = new VersionedBackendProbe(adapters, { fetch: globalThis.fetch })
        const connected = await probe.probe({
          endpoint: started.endpoint,
          source: 'configured',
          runtimeVersion,
          confidence: 1,
        })
        expect(connected, 'the real DSH endpoint must answer the probe').toBeDefined()
        if (connected === undefined) return
        steps.push(
          `probe dsh=${connected.capabilities.dshVersion} protocol=${connected.capabilities.protocolVersion} adapter=${connected.capabilities.adapterId ?? 'unset'} mode=${connected.capabilities.compatibilityMode ?? 'unset'}`,
        )
        expect(connected.capabilities.protocolVersion).toBeTruthy()
        expect(connected.capabilities.adapterId).toBeTruthy()

        const backend = await new VersionedBackendFactory(adapters).connect(connected)
        try {
          const page = await backend.sessions.list()
          expect(Array.isArray(page.items)).toBe(true)
          steps.push(`session.list ${page.items.length} session(s)`)
          const workspaces = await backend.workspaces.list()
          steps.push(`workspace.list ${workspaces.length} workspace(s)`)
          const unsubscribe = backend.events.subscribe(() => undefined)
          unsubscribe()
          steps.push('events.subscribe released')
        } finally {
          await backend.close()
          steps.push('backend closed')
        }
      } finally {
        await handle?.stop()
        if (handle !== undefined) {
          expect(await canConnect(port), `loopback port ${port} must be released`).toBe(false)
          steps.push(`managed stop port ${port} closed`)
        }
        await rm(workspace, { recursive: true, force: true })
        for (const step of steps) console.log(`[dsh-live-smoke] ${step}`)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

function adapterOptions(cookie: {
  readonly value: string | undefined
}): ConstructorParameters<typeof Rc151VersionAdapter>[0] {
  return {
    requestTimeoutMs: 10_000,
    retryPolicy: { maximumAttempts: 2, baseDelayMs: 100, maximumDelayMs: 500 },
    fetch: globalThis.fetch,
    samePath: (left: string, right: string) => path.resolve(left) === path.resolve(right),
    authCookie: () => cookie.value,
  }
}

function assertLoopbackEndpoint(endpoint: BackendEndpoint): void {
  expect(['127.0.0.1', 'localhost']).toContain(endpoint.host)
  expect(endpoint.baseUrl).toBe(`http://${endpoint.host}:${endpoint.port}`)
}

function spawnManagedChild(
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
  return {
    pid: child.pid ?? -1,
    stdout: textStream(child.stdout),
    stderr: textStream(child.stderr),
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal)
    },
    exited: new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    }),
  }
}

async function* textStream(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) return
  for await (const chunk of stream) yield Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

function freeLoopbackPort(): Promise<number> {
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

function canConnect(port: number): Promise<boolean> {
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
