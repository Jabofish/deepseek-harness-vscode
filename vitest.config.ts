import { configDefaults, defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'

const live = process.env.DSH_LIVE_SMOKE === '1'
const exclude = [...configDefaults.exclude, '**/*.stress.spec.ts?(x)']
const nativeBuildTest = 'apps/webview/src/styles/deferred-assets.spec.ts'

export default defineConfig({
  test: {
    environment: 'node',
    pool: live ? 'forks' : 'threads',
    maxWorkers: Math.min(8, availableParallelism()),
    ...(live ? { fileParallelism: false } : {}),
    exclude,
    tags: [{ name: 'stress', skip: true }],
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: [
            'packages/**/*.spec.ts',
            'tests/**/*.spec.ts',
            'apps/extension/**/*.spec.ts?(x)',
            nativeBuildTest,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'webview',
          pool: 'vmThreads',
          vmMemoryLimit: '512MB',
          include: ['apps/webview/**/*.spec.ts?(x)'],
          exclude: [...exclude, nativeBuildTest],
        },
      },
    ],
    experimental: { fsModuleCache: true, fsModuleCachePath: 'node_modules/.cache/vitest' },
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
