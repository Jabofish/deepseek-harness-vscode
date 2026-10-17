import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Leave capacity for the concurrent typecheck/lint/build checks. Unbounded
    // workers can starve esbuild and turn cold integration imports into timeouts.
    maxWorkers: 8,
    include: ['packages/**/*.spec.ts', 'tests/**/*.spec.ts', 'apps/**/*.spec.ts?(x)'],
    // The live smoke boots real DSH processes through the managed launch
    // contract, which allows one boot at a time and spends most of a spec's
    // 90s budget on host reads. Running those files concurrently made a spec
    // wait on the cross-process lock past its own timeout, so the whole
    // directory run reported a bare timeout with no evidence printed. Unit
    // runs, where the live specs are skipped, keep the default parallelism.
    ...(process.env.DSH_LIVE_SMOKE === '1' ? { fileParallelism: false } : {}),
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
