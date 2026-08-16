import { context } from 'esbuild'
import process from 'node:process'

const watch = process.argv.includes('--watch')
const buildContext = await context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node22',
  logLevel: 'info',
})

if (watch) {
  await buildContext.watch()
} else {
  await buildContext.rebuild()
  await buildContext.dispose()
}
