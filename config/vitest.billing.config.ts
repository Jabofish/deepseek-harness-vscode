import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      react: resolve('apps/webview/node_modules/react'),
      'react-dom': resolve('apps/webview/node_modules/react-dom'),
      ...Object.fromEntries(
        ['domain', 'application', 'dsh-adapter', 'webview-protocol', 'timeline', 'ui'].map((name) => [
          `@dsh-vscode/${name}`,
          resolve(`packages/${name}/src/index.ts`),
        ]),
      ),
    },
  },
  test: { environment: 'jsdom', include: ['tests/billing/*.spec.tsx'], maxWorkers: 1, testTimeout: 25_000 },
})
