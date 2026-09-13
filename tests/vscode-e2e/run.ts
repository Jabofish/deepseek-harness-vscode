import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runTests } from '@vscode/test-electron'

export async function run(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-vscode-e2e-'))
  const workspace = path.join(root, 'workspace')
  const settingsDirectory = path.join(workspace, '.vscode')
  const managed = process.env.DSH_VSCODE_E2E_MODE === 'managed'
  const runtimeExecutable = process.env.DSH_VSCODE_E2E_RUNTIME
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
    await import('node:fs/promises').then(({ mkdir }) => mkdir(settingsDirectory, { recursive: true }))
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
          'dsh.connection.mode': managed ? 'new-isolated' : 'attach-only',
          'dsh.connection.attachPorts': managed ? [] : [address.port],
          'dsh.connection.discoveryTimeoutMs': 3_000,
          'dsh.connection.requestTimeoutMs': 5_000,
          'dsh.runtime.autoStart': managed,
          ...(runtimeExecutable === undefined ? {} : { 'dsh.runtime.executablePath': runtimeExecutable }),
        },
        null,
        2,
      ),
      'utf8',
    )
    console.log(
      `[dsh-vscode-e2e] mode=${managed ? 'managed' : 'attach-only'} fixture listening on loopback port ${address.port}`,
    )
    if (managed)
      console.log(`[dsh-vscode-e2e] managed runtime: ${runtimeExecutable ?? 'discovered from PATH'}`)
    const vscodeExecutablePath = process.env.DSH_VSCODE_E2E_EXECUTABLE
    console.log(
      vscodeExecutablePath === undefined
        ? '[dsh-vscode-e2e] no local executable override; runTests may download VS Code 1.125.0'
        : '[dsh-vscode-e2e] using the executable from DSH_VSCODE_E2E_EXECUTABLE',
    )
    await runTests({
      version: '1.125.0',
      ...(vscodeExecutablePath === undefined ? {} : { vscodeExecutablePath }),
      extensionDevelopmentPath: path.resolve('apps/extension'),
      extensionTestsPath: path.resolve('tests/vscode-e2e/suite'),
      // Codex/VS Code terminals can inherit this Electron switch. Passing it
      // through makes Code.exe execute the workspace path as a Node script.
      extensionTestsEnv: { ELECTRON_RUN_AS_NODE: undefined },
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
    if (!managed) {
      // The suite asserts this too, but a suite that silently stops asking is
      // exactly the failure mode this fixture exists to catch.
      const attached =
        observations.muxUpgrades >= 1 && observations.hostUpgrades >= 1 && observations.methods.length >= 1
      if (!attached)
        throw new Error(
          `The attach-only fixture was never used by the extension host: ${JSON.stringify(observations)}`,
        )
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
