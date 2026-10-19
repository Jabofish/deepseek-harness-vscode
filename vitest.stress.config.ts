import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'packages/**/*.stress.spec.ts',
      'tests/**/*.stress.spec.ts',
      'apps/**/*.stress.spec.ts?(x)',
      'apps/extension/src/view/transcript-window.spec.ts',
      'apps/extension/src/view/native-session-list.spec.ts',
      'apps/webview/src/features/inspector/SessionInspector.spec.tsx',
      'apps/webview/src/app/store/opening-state.spec.ts',
      'packages/dsh-adapter/test/remote-mux-lifecycle.spec.ts',
      'packages/timeline/test/usage.spec.ts',
    ],
    exclude: configDefaults.exclude,
    tags: [{ name: 'stress' }],
    experimental: { fsModuleCache: true, fsModuleCachePath: 'node_modules/.cache/vitest' },
  },
})
