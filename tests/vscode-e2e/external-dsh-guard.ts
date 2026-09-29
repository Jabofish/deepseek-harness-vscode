import { readdir, readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * The `auto` mode registers every discovery provider, so it can attach to a
 * DSH that this run does not own — including the developer's own instance.
 * `DSH_HOME` does not cover that: the default-port and process providers do
 * not read the home at all. The runner therefore refuses to start `auto`
 * unless these sources are quiet.
 *
 * `@dsh-vscode/dsh-adapter` owns the canonical `DEFAULT_DSH_WEB_PORT`, but this
 * module is loaded by plain Node and the adapter's `.js` specifiers only resolve
 * under vitest, so the value is restated here and pinned by a spec assertion.
 */
export const DEFAULT_DSH_WEB_PORT = 3_080

const PROBE_TIMEOUT_MS = 500

export interface ExternalDshEndpoint {
  readonly source: 'default-port' | 'companion-registry'
  readonly port: number
}

/**
 * Mirrors `CompanionRegistryDiscoveryProvider`, which reads
 * `<DSH_HOME>/runtime/vscode/instances/*.json`. The runner cannot import that
 * module: extension sources use `.js` specifiers that only resolve under
 * vitest, and this file must load in plain Node.
 */
export async function companionRegistryPorts(home: string): Promise<number[]> {
  const directory = path.join(home, 'runtime', 'vscode', 'instances')
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return []
  }
  const ports: number[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path.join(directory, entry), 'utf8'))
    } catch {
      continue
    }
    const port = (parsed as { port?: unknown }).port
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535) ports.push(port)
  }
  return ports
}

export async function isLoopbackPortReachable(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const settle = (reachable: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    // ECONNREFUSED means nothing is listening; EACCES/EPERM means we cannot
    // tell, which the caller must treat as "not quiet" rather than "quiet".
    socket.once('error', (error: NodeJS.ErrnoException) =>
      settle(error.code === 'ECONNREFUSED' ? false : true),
    )
  })
}

/**
 * Every endpoint `auto` would consider before it starts anything of its own.
 * `defaultPort` exists so a spec can exercise both a serving and a quiet
 * default port without taking over the port a real DSH would use.
 */
export async function discoverExternalDshEndpoints(
  productionHome = path.join(os.homedir(), '.dsh'),
  defaultPort = DEFAULT_DSH_WEB_PORT,
): Promise<readonly ExternalDshEndpoint[]> {
  const registryPorts = await companionRegistryPorts(productionHome)
  const candidates: ExternalDshEndpoint[] = [
    { source: 'default-port', port: defaultPort },
    ...[...new Set(registryPorts)].map((port): ExternalDshEndpoint => ({
      source: 'companion-registry',
      port,
    })),
  ]
  const reachability = await Promise.all(candidates.map((entry) => isLoopbackPortReachable(entry.port)))
  return candidates.filter((_, index) => reachability[index])
}
