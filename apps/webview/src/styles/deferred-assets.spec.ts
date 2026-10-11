import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { build } from 'vite'
import { expect, it } from 'vitest'
import productionConfig from '../../vite.config.js'

it('loads deferred CSS below the extension media URI without nonce-less script preloads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-webview-assets-'))
  try {
    await Promise.all([
      writeFile(path.join(root, 'main.js'), "globalThis.loadSettings = () => import('./settings.js')"),
      writeFile(path.join(root, 'settings.js'), "import './settings.css'; export const title = 'Settings'"),
      writeFile(
        path.join(root, 'settings.css'),
        "@font-face { font-family: fixture; src: url('./fixture.woff2') } .settings { color: red; }",
      ),
      writeFile(path.join(root, 'fixture.woff2'), Buffer.from('font fixture')),
    ])
    const result = await build({
      ...productionConfig,
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        ...productionConfig.build,
        write: false,
        sourcemap: false,
        minify: false,
        rollupOptions: {
          ...productionConfig.build?.rollupOptions,
          input: path.join(root, 'main.js'),
        },
      },
    })
    if (Array.isArray(result) || !('output' in result)) throw new Error('Expected one production output')
    const entry = result.output.find((item) => item.type === 'chunk' && item.isEntry)
    if (entry?.type !== 'chunk') throw new Error('Missing entry chunk')
    const css = result.output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    expect(css).toHaveLength(1)
    expect(result.output.some((item) => item.type === 'asset' && item.fileName.endsWith('.woff2'))).toBe(true)
    expect(css[0]?.type === 'asset' ? css[0].source : '').not.toContain('data:font')
    const preloadTargets: string[] = []
    const source = ts.createSourceFile('webview.js', entry.code, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const values = node.elements.filter(ts.isStringLiteral).map((item) => item.text)
        if (values.some((value) => css.some((asset) => value.endsWith(asset.fileName))))
          preloadTargets.push(...values)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(preloadTargets).toHaveLength(1)
    const mediaUri = 'https://webview.example/extension-install/media/'
    for (const target of preloadTargets) {
      expect(new URL(target, `${mediaUri}${entry.fileName}`).href).toBe(`${mediaUri}${css[0]?.fileName}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
