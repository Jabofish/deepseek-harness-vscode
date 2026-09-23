import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertBundleTranslatesImportMeta,
  createImportMetaUrlPlugin,
} from '../../esbuild-import-meta-url.mjs'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dsh-import-meta-'))
  temporaryDirectories.push(directory)
  return directory
}

/** A `@deepseek-ai` package laid out the way the pnpm store installs it. */
function upstreamModule(source: string, manifest: unknown = { version: '0.1.7-alpha.1' }): string {
  const packageRoot = path.join(temporaryDirectory(), 'node_modules', '@deepseek-ai', 'probe-package')
  mkdirSync(path.join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify(manifest))
  writeFileSync(path.join(packageRoot, 'lib', 'index.js'), source)
  return path.join(packageRoot, 'lib', 'index.js')
}

/** A module outside the `@deepseek-ai` scope, which the plugin leaves alone. */
function plainModule(files: Readonly<Record<string, string>>): string {
  const directory = temporaryDirectory()
  for (const [name, source] of Object.entries(files)) writeFileSync(path.join(directory, name), source)
  return path.join(directory, 'entry.js')
}

async function bundle(entryPoint: string): Promise<string> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [createImportMetaUrlPlugin()],
  })
  return result.outputFiles?.[0]?.text ?? ''
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('esbuild import.meta.url handling', () => {
  it('inlines the manifest version an upstream module would have read', async () => {
    const entryPoint = upstreamModule(
      [
        `import { createRequire } from 'node:module'`,
        `const { version: doubleQuoted } = createRequire(import.meta.url)("../package.json")`,
        `const { version: singleQuoted } = createRequire(import.meta.url)('../package.json')`,
        `export const identities = [doubleQuoted, singleQuoted]`,
      ].join('\n'),
    )

    const artifact = await bundle(entryPoint)

    expect(artifact.match(/"0\.1\.7-alpha\.1"/gu)).toHaveLength(2)
    expect(artifact).not.toContain('import_meta.url')
  })

  it('refuses an upstream shape it cannot translate', async () => {
    const entryPoint = upstreamModule(
      [
        `import { createRequire } from 'node:module'`,
        `const require = createRequire(import.meta.url)`,
        `export const load = () => require('../package.json')`,
      ].join('\n'),
    )

    await expect(bundle(entryPoint)).rejects.toThrow(/teach this plugin the new shape/u)
  })

  it('refuses a manifest that declares no version', async () => {
    const entryPoint = upstreamModule(
      `import { createRequire } from 'node:module'\nexport const identity = createRequire(import.meta.url)("../package.json")\n`,
      { name: '@deepseek-ai/probe-package' },
    )

    await expect(bundle(entryPoint)).rejects.toThrow(/declares no version/u)
  })

  it('fails the build when a bundled module keeps reading import.meta', async () => {
    const entryPoint = plainModule({
      'plain.js': [
        `import { createRequire } from 'node:module'`,
        `export const identity = createRequire(import.meta.url)('./package.json')`,
      ].join('\n'),
      'entry.js': `import { identity } from './plain.js'\nexport default identity\n`,
    })

    await expect(bundle(entryPoint)).rejects.toThrow(/still reads import_meta\.url/u)
  })

  it('rejects an artifact whose import.meta read survived bundling', () => {
    const untranslated = `var load = (0, import_node_module.createRequire)(import_meta.url)("../package.json");`
    expect(() => assertBundleTranslatesImportMeta(untranslated)).toThrow(/import_meta\.url/u)
    expect(() => assertBundleTranslatesImportMeta(`var version = "0.1.7-alpha.1";`)).not.toThrow()
  })

  it('is wired into the extension build', () => {
    const buildScript = readFileSync(new URL('../../esbuild.mjs', import.meta.url), 'utf8')
    expect(buildScript).toContain('createImportMetaUrlPlugin')
  })
})
