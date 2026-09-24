import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'artifacts/**',
      '**/.vscode-test/**',
      'apps/extension/media/**',
      'tests/vscode-e2e/suite/**',
      'DSH_VSCODE_IMPLEMENTATION_PLAN.md',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.mjs',
            'vitest.config.ts',
            'apps/extension/esbuild.mjs',
            'apps/extension/esbuild-import-meta-url.mjs',
            'apps/extension/esbuild-import-meta-url.d.mts',
            'scripts/publish-marketplace.cjs',
            'scripts/patch-js-debug-ipv6-probe.cjs',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: [
      '**/*.config.{js,mjs,ts}',
      'eslint.config.mjs',
      'apps/extension/esbuild.mjs',
      'scripts/**/*.{cjs,mjs}',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      globals: {
        __dirname: 'readonly',
        console: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // A plain-JavaScript build plugin carries no annotations for the typed
    // rules to read, so the checked-any family cannot apply to it.
    files: ['apps/extension/esbuild-import-meta-url.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
)
