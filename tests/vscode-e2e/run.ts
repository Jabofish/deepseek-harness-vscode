import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'

import { resolveLiveRuntime } from '../live-dsh/runtime.ts'
import { resolveVscodeExecutable } from './vscode-executable.ts'
import { discoverExternalDshEndpoints } from './external-dsh-guard.ts'

/** Not a path, so the extension's settings validation must reject it. */
const INVALID_EXECUTABLE_PATH = 'relative/dsh'

/**
 * `managed` keeps the runtime behind the `new-isolated` contract, `auto` is the
 * shipped default that discovers first and only starts what it must, and
 * `attach-only` never starts anything.
 */
type E2eMode = 'attach-only' | 'managed' | 'auto'

function resolveMode(raw: string | undefined): E2eMode {
  if (raw === undefined || raw === '' || raw === 'attach-only') return 'attach-only'
  if (raw === 'managed' || raw === 'auto') return raw
  throw new Error(`Unknown DSH_VSCODE_E2E_MODE "${raw}". Use attach-only, managed or auto.`)
}

export async function run(): Promise<void> {
  // Resolved before the fixture exists: a missing override must fail without
  // creating a temp workspace, and must never fall back to a download.
  const vscodeExecutablePath = resolveVscodeExecutable(process.env.DSH_VSCODE_E2E_EXECUTABLE)
  const mode = resolveMode(process.env.DSH_VSCODE_E2E_MODE)
  const startsRuntime = mode === 'managed' || mode === 'auto'
  // `auto` runs every discovery provider, and the default-port and process
  // providers ignore DSH_HOME entirely. Attaching to a DSH this run does not
  // own would touch the developer's real sessions, so refuse before anything
  // exists on disk.
  if (mode === 'auto') {
    const external = await discoverExternalDshEndpoints()
    if (external.length > 0)
      throw new Error(
        `auto mode refused to start: ${external.map((entry) => `${entry.source}:${entry.port}`).join(', ')} ` +
          'is already serving a DSH this run does not own. Stop that instance or use managed.',
      )
    console.log('[dsh-vscode-e2e] auto pre-check found no externally owned DSH endpoint')
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-vscode-e2e-'))
  const workspace = path.join(root, 'workspace')
  const settingsDirectory = path.join(workspace, '.vscode')
  // Managed and auto modes start a real DSH. Without an explicit home it would
  // use the user's own profile, so the scenario always runs against a directory
  // inside this test-owned root and the Extension Host is told to expect it.
  const isolatedHome = startsRuntime ? path.join(root, 'dsh-home') : undefined
  const invalidSettings = process.env.DSH_VSCODE_E2E_INVALID_SETTINGS === '1'
  // `dsh.runtime.executablePath` is an absolute path by contract, so a bare
  // command name has to be resolved before it is written. Letting it through
  // would fail extension activation with an invalid-settings error instead of
  // launching the runtime the environment variable asked for.
  const requestedRuntime = process.env.DSH_VSCODE_E2E_RUNTIME?.trim()
  let runtimeExecutable =
    requestedRuntime === undefined || requestedRuntime === ''
      ? undefined
      : resolveLiveRuntime(requestedRuntime)
  if (
    startsRuntime &&
    process.platform === 'win32' &&
    runtimeExecutable !== undefined &&
    /\.js$/iu.test(runtimeExecutable)
  ) {
    // The production launcher accepts a Windows npm shim. Give a source-built
    // CLI the same shape inside this test-owned temporary directory.
    const shim = path.join(root, 'dsh-source.cmd')
    await writeFile(shim, `@echo off\r\nnode "${runtimeExecutable}" %*\r\n`, 'utf8')
    runtimeExecutable = shim
  }
  const executablePathSetting = invalidSettings ? INVALID_EXECUTABLE_PATH : runtimeExecutable
  const fixtureSockets = new Set<Duplex>()
  const observations: FixtureObservations = {
    methods: [],
    muxUpgrades: 0,
    hostUpgrades: 0,
    rejectedUpgrades: 0,
  }
  const server = createServer((request, response) => {
    void handleFixtureRequest(request, response, observations)
  })
  server.on('upgrade', (request, socket) => {
    if (request.url !== '/api/events.mux' && request.url !== '/api/events.host') {
      observations.rejectedUpgrades += 1
      socket.destroy()
      return
    }
    if (request.url === '/api/events.mux') observations.muxUpgrades += 1
    else observations.hostUpgrades += 1
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    console.log(`[dsh-vscode-e2e] fixture WebSocket upgrade ${request.url}`)
    fixtureSockets.add(socket)
    socket.once('close', () => fixtureSockets.delete(socket))
    socket.once('error', () => fixtureSockets.delete(socket))
  })
  try {
    await writeFile(path.join(root, 'workspace-marker.txt'), 'test-owned\n', 'utf8')
    await mkdir(settingsDirectory, { recursive: true })
    if (isolatedHome !== undefined) await mkdir(isolatedHome, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string')
      throw new Error('The E2E fixture did not receive a TCP port.')
    await writeFile(
      path.join(settingsDirectory, 'settings.json'),
      JSON.stringify(
        {
          'dsh.connection.mode':
            mode === 'auto' ? 'auto' : mode === 'managed' ? 'new-isolated' : 'attach-only',
          // auto must not see the fixture as a candidate, or the run would prove
          // an attach to simulated traffic instead of discovery over a real runtime.
          'dsh.connection.attachPorts': startsRuntime ? [] : [address.port],
          'dsh.connection.discoveryTimeoutMs': 3_000,
          'dsh.connection.requestTimeoutMs': 5_000,
          'dsh.runtime.autoStart': startsRuntime,
          ...(executablePathSetting === undefined
            ? {}
            : { 'dsh.runtime.executablePath': executablePathSetting }),
        },
        null,
        2,
      ),
      'utf8',
    )
    console.log(`[dsh-vscode-e2e] mode=${mode} fixture listening on loopback port ${address.port}`)
    if (invalidSettings)
      console.log(
        `[dsh-vscode-e2e] invalid-settings scenario: dsh.runtime.executablePath=${INVALID_EXECUTABLE_PATH}`,
      )
    if (startsRuntime)
      console.log(
        `[dsh-vscode-e2e] ${mode} runtime: ${runtimeExecutable ?? 'discovered from PATH'}; user profile excluded via an isolated DSH home`,
      )
    console.log('[dsh-vscode-e2e] using the executable from DSH_VSCODE_E2E_EXECUTABLE')
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: path.resolve('apps/extension'),
      extensionTestsPath: path.resolve('tests/vscode-e2e/suite'),
      extensionTestsEnv: {
        // Codex/VS Code terminals can inherit this Electron switch. Passing it
        // through makes Code.exe execute the workspace path as a Node script.
        ELECTRON_RUN_AS_NODE: undefined,
        ...(invalidSettings ? { DSH_VSCODE_E2E_INVALID_SETTINGS: '1' } : {}),
        // The Extension Host passes its environment to the DSH it starts, and
        // the suite refuses to connect unless both point at the same
        // test-owned home.
        ...(isolatedHome === undefined ? {} : { DSH_HOME: isolatedHome, DSH_VSCODE_E2E_HOME: isolatedHome }),
      },
      // The temp workspace must count as trusted, otherwise the extension is
      // required to refuse an automatic start and managed mode can never run.
      launchArgs: [
        workspace,
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
    })
    console.log(
      `[dsh-vscode-e2e] fixture observed methods=[${observations.methods.join(',')}] mux=${observations.muxUpgrades} host=${observations.hostUpgrades}`,
    )
    if (isolatedHome !== undefined && !invalidSettings) {
      // The managed analog of the attach fixture assertion below: a scenario
      // that never wrote to its own home did not start a real runtime there,
      // and an empty home would mean the runtime used the user's profile.
      const entries = await readdir(isolatedHome)
      console.log(
        `[dsh-vscode-e2e] managed runtime left ${entries.length} source${entries.length === 1 ? '' : 's'} in the isolated DSH home`,
      )
      if (entries.length === 0)
        throw new Error(
          'The managed DSH runtime never wrote to the isolated DSH home, so the run cannot prove it started against it.',
        )
    }
    if (mode === 'attach-only' && !invalidSettings) {
      // The suite asserts this too, but a suite that silently stops asking is
      // exactly the failure mode this fixture exists to catch.
      const attached =
        observations.muxUpgrades >= 1 && observations.hostUpgrades >= 1 && observations.methods.length >= 1
      if (!attached)
        throw new Error(
          `The attach-only fixture was never used by the extension host: ${JSON.stringify(observations)}`,
        )
    }
    if (mode === 'auto' && !invalidSettings) {
      // The extension owns only what auto started here, so once the Extension
      // Host has exited nothing on these endpoints may still be serving. A
      // surviving endpoint would mean the owned runtime was never released.
      const stillServing = await discoverExternalDshEndpoints()
      if (stillServing.length > 0)
        throw new Error(
          `auto mode left ${stillServing.map((entry) => `${entry.source}:${entry.port}`).join(', ')} serving after the Extension Host exited.`,
        )
      console.log('[dsh-vscode-e2e] auto released every endpoint it was allowed to own')
    }
  } finally {
    for (const socket of fixtureSockets) socket.destroy()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    await rm(root, { recursive: true, force: true })
  }
}

interface FixtureObservations {
  /** RPC method names the extension host actually asked for, in order. */
  readonly methods: string[]
  muxUpgrades: number
  hostUpgrades: number
  rejectedUpgrades: number
}

async function handleFixtureRequest(
  request: IncomingMessage,
  response: ServerResponse,
  observations: FixtureObservations,
): Promise<void> {
  if (request.url === '/api/events.mux' || request.url === '/api/events.host') {
    response.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
    response.end('upgrade required')
    return
  }
  // Test-only channel: the extension host suite reads this to assert what the
  // extension actually did over the wire instead of trusting a command result.
  if (request.url === '/__e2e/observations') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(observations))
    return
  }
  let body = ''
  for await (const chunk of request) body += String(chunk)
  let rpcId: unknown
  try {
    rpcId = (JSON.parse(body) as { rpcId?: unknown }).rpcId
  } catch {
    rpcId = undefined
  }
  const method = request.url?.replace(/^\/api\//, '') ?? ''
  if (!observations.methods.includes(method)) observations.methods.push(method)
  const value =
    method === 'host.describe'
      ? {
          version: '0.1.0-rc.8',
          cwd: workspaceCwd(),
          attachedSessions: 0,
          home: 'e2e-home',
          canOpenPath: true,
        }
      : method === 'session.list'
        ? { items: [] }
        : {}
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      type: 'server-response',
      ...(typeof rpcId === 'string' ? { rpcId } : {}),
      result: { ok: true, value },
    }),
  )
}

function workspaceCwd(): string {
  return 'e2e-fixture'
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run()
}
