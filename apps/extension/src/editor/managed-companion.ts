import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DshRuntime } from '@dsh-vscode/domain'
import { resolveWindowsShim } from '../backend/windows-shim.js'

/** Verified CLI overlay family; unknown runtimes still start normally without this optional overlay. */
export function supportsCompanionOverlay(version: string): boolean {
  return /^(?:dsh-v|v)?(?:0\.2\.0-rc\.2|0\.2\.1-(?:alpha\.[1-5]|rc\.[12]))$/u.test(version)
}

/** No profile mutation, package manager, network install or workspace source dependency. */
export async function managedCompanionArguments(
  runtime: DshRuntime,
  resources: string,
  storage: string,
  signal: AbortSignal,
): Promise<readonly string[]> {
  signal.throwIfAborted()
  try {
    const bundle = path.join(resources, 'editor-companion-runtime.mjs')
    const bytes = await readFile(bundle)
    const executable = runtime.executable
    const shim =
      process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)
        ? resolveWindowsShim(executable, 'windows', (file) => requireText(file), {
            nodeExecutable: process.execPath,
          })
        : undefined
    const entry = shim?.prefixArgs.find((argument) => /\.(?:c|m)?js$/iu.test(argument)) ?? executable
    if (!supportsCompanionOverlay(runtime.version)) {
      // Future versions opt in through their own read-only CLI advertisement,
      // not a guessed version range. No optional flag is sent before this probe.
      const js = /\.(?:c|m)?js$/iu.test(executable)
      const command = shim?.executable ?? (js ? process.execPath : executable)
      const prefix = shim?.prefixArgs ?? (js ? [executable] : [])
      const help = await promisify(execFile)(command, [...prefix, '--help'], {
        timeout: 5_000,
        maxBuffer: 65_536,
        signal,
        windowsHide: true,
      })
      if (!/(?:^|\s)--patch(?:[=\s,]|$)/mu.test(help.stdout)) return []
    }
    const require = createRequire(pathToFileURL(entry))
    const protocol = require.resolve('@deepseek-ai/dsh-typert-protocol')
    const id = createHash('sha256').update(bytes).update(protocol).digest('hex').slice(0, 24)
    const directory = path.join(storage, 'editor-companion', 'runtime', id)
    await mkdir(directory, { recursive: true })
    // Each build gets a distinct module URL, so DSH's ESM cache cannot retain
    // the previous source when the extension/package version stays unchanged.
    const factory = path.join(directory, 'companion.mjs')
    await writeFile(factory, bytes)
    const loader = path.join(directory, 'loader.mjs')
    await writeFile(
      loader,
      `import { createRequire } from 'node:module';\nimport { loadCompanion } from ${JSON.stringify(pathToFileURL(factory).href)};\nconst runtimeRequire = createRequire(${JSON.stringify(pathToFileURL(entry).href)});\nexport const name = 'vscode-editor-bridge';\nexport const inject = ['typert', 'tools'];\nexport function apply(ctx) {\n if (ctx.get('vscodeEditorBridge')) return;\n try { const plugin = loadCompanion(runtimeRequire); plugin.apply(ctx); }\n catch { ctx.logger?.warn('Editor integration is unavailable in this DSH build; chat remains available.'); }\n}\n`,
    )
    const overlay = path.join(directory, 'companion.patch.yml')
    // Reuse our own bundle row so a previously installed companion cannot win
    // over the version shipped by an extension update, or register tools twice.
    await writeFile(
      overlay,
      `- insert:\n    - id: vscode-editor-bridge\n      name: ${JSON.stringify(loader.replaceAll('\\', '/'))}\n`,
    )
    signal.throwIfAborted()
    return ['--patch', overlay]
  } catch {
    signal.throwIfAborted()
    // Optional integration cannot prevent a valid runtime from starting.
    return []
  }
}

import { readFileSync } from 'node:fs'
function requireText(file: string): string {
  return readFileSync(file, 'utf8')
}
