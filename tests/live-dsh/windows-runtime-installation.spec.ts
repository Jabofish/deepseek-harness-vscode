import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  installWindowsRuntime,
  verifyWindowsRuntime,
} from '../../apps/extension/src/vscode/windows-runtime-installation.js'
import { streamRuntimeCommand } from '../../apps/extension/src/vscode/runtime-command.js'
import type {
  RuntimeCommandOptions,
  RuntimeCommandResult,
} from '../../apps/extension/src/vscode/update-runtime.js'

const enabled = process.platform === 'win32' && process.env.DSH_LIVE_INSTALLATION === '1'

describe.skipIf(!enabled)('isolated Windows npm DSH update', () => {
  it(
    'installs two real versions, preserves the global CLI entry and verifies npm global state',
    async () => {
      const from = process.env.DSH_LIVE_INSTALL_FROM
      const to = process.env.DSH_LIVE_INSTALL_TO
      const npm = process.env.DSH_LIVE_NPM_CLI
      if (from === undefined || to === undefined || npm === undefined)
        throw new Error(
          'Set DSH_LIVE_INSTALL_FROM, DSH_LIVE_INSTALL_TO and DSH_LIVE_NPM_CLI for isolated installation validation',
        )
      const root = await fs.mkdtemp(path.join(tmpdir(), 'dsh-native-update-'))
      const environment = { ...process.env, npm_config_prefix: root }
      const output: string[] = []
      const options = {
        timeout: 20 * 60_000,
        maxBuffer: 1024 * 1024,
        env: environment,
        onOutput: (text: string) => {
          output.push(text)
        },
      }
      const execute = (
        args: readonly string[],
        commandOptions: RuntimeCommandOptions,
      ): Promise<RuntimeCommandResult> =>
        streamRuntimeCommand(process.execPath, [npm, ...args], commandOptions)
      try {
        for (const version of [from, to]) {
          const started = Date.now()
          await installWindowsRuntime(
            [
              'install',
              '--global',
              `@deepseek-ai/dsh@${version}`,
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
              '--offline',
              '--timing',
            ],
            options,
            {
              execute,
              verify: (shim, expected) => verifyWindowsRuntime(shim, expected, environment),
            },
          )
          const global = await execute(
            ['list', '--global', '@deepseek-ai/dsh', '--depth=0', '--json'],
            options,
          )
          const tree = JSON.parse(global.stdout) as { dependencies: Record<string, { version: string }> }
          expect(tree.dependencies['@deepseek-ai/dsh']?.version).toBe(version)
          await verifyWindowsRuntime(path.join(root, 'dsh.cmd'), version, environment)
          console.info(`Isolated real npm global install verified: DSH ${version}; ${Date.now() - started}ms`)
        }
        const retireTimes = output.join('').matchAll(/timing reify:retireShallow Completed in (\d+)ms/gu)
        for (const match of retireTimes) expect(Number(match[1])).toBeLessThan(1_000)
      } finally {
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    25 * 60_000,
  )
})
