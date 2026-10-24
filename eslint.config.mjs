import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.test-workspace/**',
      'artifacts/**',
      '**/.vscode-test/**',
      'apps/extension/media/**',
      'apps/extension/resources/editor-companion-runtime.mjs',
      'tests/vscode-e2e/suite/**',
      'DSH_VSCODE_IMPLEMENTATION_PLAN.md',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
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
    files: ['apps/webview/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name="select"]',
          message: 'Use SelectMenu so options, keyboard interaction and themes stay inside the Webview.',
        },
      ],
    },
  },
  {
    files: [
      '*.config.{mjs,ts}',
      'config/*.config.ts',
      'scripts/**/*.{cjs,mjs,mts}',
      'apps/extension/esbuild*.{mjs,mts}',
    ],
    languageOptions: {
      parserOptions: { projectService: false, project: './config/tsconfig.tools.json' },
    },
  },
  {
    files: ['scripts/read-stylesheet.mjs', 'apps/extension/esbuild-import-meta-url.mjs'],
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: {
          allowDefaultProject: ['scripts/read-stylesheet.mjs', 'apps/extension/esbuild-import-meta-url.mjs'],
        },
      },
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
    files: ['scripts/**/*.{cjs,mjs}'],
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
      '@typescript-eslint/no-unsafe-return': 'off',
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
