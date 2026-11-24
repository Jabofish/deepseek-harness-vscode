import { configDefaults, defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'

const live = process.env.DSH_LIVE_SMOKE === '1'
const liveInstallation = process.env.DSH_LIVE_INSTALLATION === '1'
const liveRun = live || liveInstallation
const exclude = [
  ...configDefaults.exclude,
  '**/*.stress.spec.ts?(x)',
  '**/artifacts/**',
  '**/.test-workspace/**',
]
const nativeBuildTest = 'apps/webview/src/styles/deferred-assets.spec.ts'
const nodeRealmAdapterTest = 'packages/dsh-adapter/test/loopback-api-client.spec.ts'
const vscodeMockRootTest = 'tests/alpha223-schedule-projection.spec.ts'
const offlineLiveHarnessTests = [
  'tests/live-dsh/harness.spec.ts',
  'tests/live-dsh/managed-lock.spec.ts',
  'tests/live-dsh/paging.spec.ts',
  'tests/live-dsh/runtime-scope.spec.ts',
  'tests/live-dsh/runtime.spec.ts',
]
const liveDshTests = live
  ? ['tests/live-dsh/**/*.spec.ts']
  : liveInstallation
    ? [...offlineLiveHarnessTests, 'tests/live-dsh/windows-runtime-installation.spec.ts']
    : offlineLiveHarnessTests

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: Math.min(8, availableParallelism()),
    ...(liveRun ? { fileParallelism: false } : {}),
    exclude,
    tags: [{ name: 'stress', skip: true }],
    projects: [
      {
        extends: true,
        test: {
          name: 'webview',
          pool: 'vmThreads',
          vmMemoryLimit: '512MB',
          sequence: { groupOrder: 0 },
          include: ['apps/webview/**/*.spec.ts?(x)', 'packages/ui/**/*.spec.ts?(x)'],
          exclude: [...exclude, nativeBuildTest],
        },
      },
      {
        extends: true,
        test: {
          name: 'packages',
          pool: 'threads',
          isolate: false,
          sequence: { groupOrder: 1 },
          include: ['packages/**/*.spec.ts?(x)', 'tests/*.spec.ts'],
          exclude: [...exclude, 'packages/ui/**', nodeRealmAdapterTest, vscodeMockRootTest],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          // Host tests do real file, process and build work. Worker threads
          // share one process-wide libuv pool with the main thread's module
          // transforms, which on loaded Windows machines queued 10-60 ms
          // operations past the 5 s test timeout. Child processes each get
          // their own pool (measured: slowest affected tests 3.3 s -> 0.26 s).
          pool: 'forks',
          sequence: { groupOrder: 2 },
          include: [
            'apps/extension/**/*.spec.ts?(x)',
            nodeRealmAdapterTest,
            vscodeMockRootTest,
            ...liveDshTests,
            'tests/vscode-e2e/**/*.spec.ts',
            nativeBuildTest,
          ],
        },
      },
    ],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
