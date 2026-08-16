import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.spec.ts', 'tests/**/*.spec.ts', 'apps/**/*.spec.ts?(x)'],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
