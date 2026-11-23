import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'
import { DEFAULT_INSTALL_DSH_VERSION } from '../../packages/dsh-adapter/src/contracts.ts'
import { resolveWindowsShim } from '../../apps/extension/src/backend/windows-shim.ts'

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
  const guidedInstall = process.env.DSH_VSCODE_E2E_GUIDED_INSTALL === '1'
  const requestedRuntime = process.env.DSH_VSCODE_E2E_RUNTIME?.trim()
  const invalidSettings = process.env.DSH_VSCODE_E2E_INVALID_SETTINGS === '1'
  if (guidedInstall && (mode !== 'managed' || invalidSettings || requestedRuntime))
    throw new Error(
      'Guided-install E2E requires managed mode without executable or invalid-settings overrides.',
    )
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
  const userData = path.join(root, 'vscode-user-data')
  const settingsDirectory = path.join(userData, 'User')
  const connectionMode = mode === 'managed' ? 'new-isolated' : mode
  // Managed and auto modes start a real DSH. Without an explicit home it would
  // use the user's own profile, so the scenario always runs against a directory
  // inside this test-owned root and the Extension Host is told to expect it.
  const isolatedHome = startsRuntime ? path.join(root, 'dsh-home') : undefined
  const installPrefix = guidedInstall ? path.join(root, 'npm-prefix') : undefined
  const executablePathSetting = invalidSettings ? INVALID_EXECUTABLE_PATH : undefined
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
    const runtimeExecutable =
      startsRuntime && requestedRuntime ? path.resolve(resolveLiveRuntime(requestedRuntime)) : undefined
    // Test Electron refuses modal dialogs. Expose the selected runtime through
    // PATH discovery, leaving native consent for custom settings intact.
    const runtimeBin =
      runtimeExecutable === undefined ? undefined : await prepareRuntimePath(root, runtimeExecutable)
    const pathPrefix =
      installPrefix === undefined
        ? runtimeBin
        : process.platform === 'win32'
          ? installPrefix
          : path.join(installPrefix, 'bin')
    await writeFile(path.join(root, 'workspace-marker.txt'), 'test-owned\n', 'utf8')
    await mkdir(workspace, { recursive: true })
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
          // The connection policy and executable are machine-scoped. VS Code
          // reads them from this disposable profile's User settings.
          'dsh.connection.mode': connectionMode,
          // An explicit port list limits discovery and disables automatic launch.
          ...(startsRuntime ? {} : { 'dsh.connection.attachPorts': [address.port] }),
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
        DSH_VSCODE_DEV_MANAGED_RUNTIME: undefined,
        DSH_VSCODE_E2E_EXPECTED_MODE: connectionMode,
        DSH_VSCODE_E2E_FIXTURE_PORT: startsRuntime ? undefined : String(address.port),
        DSH_VSCODE_E2E_EXPECTED_EXECUTABLE: executablePathSetting,
        ...(pathPrefix === undefined
          ? {}
          : { PATH: [pathPrefix, process.env.PATH ?? ''].join(path.delimiter) }),
        ...(invalidSettings ? { DSH_VSCODE_E2E_INVALID_SETTINGS: '1' } : {}),
        ...(process.env.DSH_VSCODE_E2E_COMPANION === '1' ? { DSH_VSCODE_E2E_COMPANION: '1' } : {}),
        ...(installPrefix === undefined
          ? {}
          : {
              npm_config_prefix: installPrefix,
              DSH_VSCODE_E2E_INSTALL_PREFIX: installPrefix,
              DSH_VSCODE_E2E_INSTALL_VERSION: DEFAULT_INSTALL_DSH_VERSION,
            }),
        // The Extension Host passes its environment to the DSH it starts, and
        // the suite refuses to connect unless both point at the same
        // test-owned home.
        ...(isolatedHome === undefined ? {} : { DSH_HOME: isolatedHome, DSH_VSCODE_E2E_HOME: isolatedHome }),
      },
      // The temp workspace must count as trusted, otherwise the extension is
      // required to refuse an automatic start and managed mode can never run.
      launchArgs: [
        workspace,
        `--user-data-dir=${userData}`,
        `--extensions-dir=${path.join(root, 'vscode-extensions')}`,
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
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function prepareRuntimePath(root: string, executable: string): Promise<string> {
  if (!(await stat(executable)).isFile()) throw new Error('The E2E runtime must be a file.')
  const bin = path.join(root, 'runtime-bin')
  await mkdir(bin)
  if (process.platform === 'win32') {
    const shim = resolveWindowsShim(executable, 'windows', (file) => readFileSync(file, 'utf8'))
    const target = shim?.prefixArgs[0] ?? shim?.executable ?? executable
    if (!/\.(?:[cm]?js|exe)$/iu.test(target))
      throw new Error('The E2E runtime must resolve to a Windows executable or a Node entrypoint.')
    if (!(await stat(target)).isFile()) throw new Error('The Windows E2E runtime target must be a file.')
    const command = /\.exe$/iu.test(target) ? `"${target}"` : `node "${target}"`
    await writeFile(path.join(bin, 'dsh.cmd'), `@echo off\r\n${command} %*\r\n`, 'utf8')
  } else {
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const command = /\.[cm]?js$/iu.test(executable)
      ? `${quote(process.execPath)} ${quote(executable)}`
      : quote(executable)
    await writeFile(path.join(bin, 'dsh'), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700 })
  }
  return bin
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
