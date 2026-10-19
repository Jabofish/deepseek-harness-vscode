import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_EDITOR_INTEGRATION, type DshRuntime } from '@dsh-vscode/domain'
import {
  configuredCompanionArguments,
  managedCompanionArguments,
  supportsCompanionOverlay,
} from './managed-companion.js'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(help = '--patch <file>'): Promise<{ runtime: DshRuntime; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-managed-test-'))
  roots.push(root)
  await writeFile(
    path.join(root, 'editor-companion-runtime.mjs'),
    'export const loadCompanion = () => ({ apply() {} })',
  )
  const directory = path.join(root, 'node_modules/@deepseek-ai/dsh-typert-protocol')
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', main: 'index.cjs' }),
  )
  await writeFile(path.join(directory, 'index.cjs'), 'module.exports = {}')
  const executable = path.join(root, 'runtime.mjs')
  await writeFile(executable, `process.stdout.write(${JSON.stringify(help)})`)
  return {
    root,
    runtime: {
      executable,
      version: '0.2.1-rc.2',
      supported: true,
      source: 'configured',
      compatibility: 'known',
    },
  }
}
describe('managed companion without profile installation', () => {
  it('does not prepare or load a companion before consent, including development launches', async () => {
    const { root, runtime } = await fixture()
    const storage = path.join(root, 'storage')
    const signal = new AbortController().signal
    for (const [preferences, trusted] of [
      [DEFAULT_EDITOR_INTEGRATION, true],
      [{ ...DEFAULT_EDITOR_INTEGRATION, autoSetup: true, enabled: false }, true],
      [{ ...DEFAULT_EDITOR_INTEGRATION, autoSetup: true }, false],
    ] as const) {
      expect(
        await configuredCompanionArguments(runtime, root, storage, signal, preferences, trusted),
      ).toEqual([])
      await expect(stat(storage)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(
      (
        await configuredCompanionArguments(
          runtime,
          root,
          storage,
          signal,
          { ...DEFAULT_EDITOR_INTEGRATION, autoSetup: true },
          true,
        )
      )[0],
    ).toBe('--patch')
    expect((await stat(storage)).isDirectory()).toBe(true)
  })
  it('loads updated source without a version bump or ESM cache reuse and preserves the previous build', async () => {
    const { root, runtime } = await fixture()
    const bundle = path.join(root, 'editor-companion-runtime.mjs')
    const source = (build: string): string =>
      `export const loadCompanion = () => ({ apply(ctx) { ctx.build = ${JSON.stringify(build)} } })`
    await writeFile(bundle, source('first'))
    const first = await managedCompanionArguments(runtime, root, root, new AbortController().signal)
    await writeFile(bundle, source('second'))
    const second = await managedCompanionArguments(runtime, root, root, new AbortController().signal)
    expect(second).not.toEqual(first)
    for (const [args, expected] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      const context = { get: () => undefined, build: '' }
      const loader = path.join(path.dirname(args[1] ?? ''), 'loader.mjs')
      const plugin = (await import(pathToFileURL(loader).href)) as { apply: (ctx: typeof context) => void }
      plugin.apply(context)
      expect(context.build).toBe(expected)
    }
  })
  it('prepares only an extension-owned overlay and resolves services from the selected runtime', async () => {
    const { root, runtime } = await fixture()
    const args = await managedCompanionArguments(runtime, root, root, new AbortController().signal)
    expect(args[0]).toBe('--patch')
    const overlay = await readFile(args[1] ?? '', 'utf8')
    expect(overlay).toContain('id: vscode-editor-bridge')
    expect(overlay).toContain('loader.mjs')
    const again = await managedCompanionArguments(runtime, root, root, new AbortController().signal)
    expect(again).toEqual(args)
    await expect(managedCompanionArguments(runtime, root, root, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
  it('probes a future CLI before using an optional flag, and leaves unsupported runtimes usable', async () => {
    const { root, runtime } = await fixture()
    const future = { ...runtime, version: '0.9.0', compatibility: 'unknown' as const }
    expect(supportsCompanionOverlay(future.version)).toBe(false)
    expect((await managedCompanionArguments(future, root, root, new AbortController().signal))[0]).toBe(
      '--patch',
    )
    await writeFile(runtime.executable, 'process.stdout.write("usage: dsh --profile web")')
    expect(await managedCompanionArguments(future, root, root, new AbortController().signal)).toEqual([])
    expect(
      await managedCompanionArguments(
        runtime,
        path.join(root, 'missing'),
        root,
        new AbortController().signal,
      ),
    ).toEqual([])
  })
})
