import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  discoverCandidateTestFiles,
  isForceRerunTrigger,
  selectAffectedTests,
} from '../scripts/changed-test-selection.mjs'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixtureWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-test-changed-'))
  tempRoots.push(root)
  const write = (rel: string, content: string): void => {
    const target = join(root, rel)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }

  write(
    'packages/domain/package.json',
    JSON.stringify({
      name: '@fixture/domain',
      exports: {
        '.': './src/index.ts',
        './sub/*': './src/sub/*.ts',
      },
    }),
  )
  write('packages/domain/src/index.ts', "export * from './core.js'\n")
  write('packages/domain/src/core.ts', 'export const coreValue = 1\n')
  write('packages/domain/src/sub/extra.ts', 'export const extraValue = 2\n')

  write('apps/webview/src/styles/tokens.css', ':root { --gap: 4px; }\n')
  write('apps/webview/src/styles/app.css', "@import './tokens.css';\n")
  write(
    'apps/webview/src/view.tsx',
    "import './styles/app.css'\nimport { coreValue } from '@fixture/domain'\nexport const view = coreValue\n",
  )
  write('apps/webview/src/view.spec.tsx', "import { view } from './view.js'\nexport const ok = view\n")

  write(
    'apps/extension/src/router.ts',
    "import { extraValue } from '@fixture/domain/sub/extra'\nexport const router = extraValue\n",
  )
  write(
    'apps/webview/src/router-bridge.spec.ts',
    [
      'const mod = await vi.importActual<{',
      '  Router: new (deps: { send(x: string): Promise<void> }) => { run(): void }',
      "}>('../../extension/src/router.js')",
      'export const bridge = mod',
    ].join('\n'),
  )
  write(
    'apps/extension/src/mocked.spec.ts',
    "vi.mock('./router.js', () => ({ router: 0 }))\nexport const mocked = true\n",
  )
  write('apps/extension/src/unrelated.spec.ts', 'export const independent = true\n')
  write('apps/extension/src/heavy.stress.spec.ts', 'export const stress = true\n')
  write('tests/live-dsh/harness.spec.ts', 'export const offlineHarness = true\n')
  write('tests/live-dsh/run.spec.ts', 'export const liveSmoke = true\n')
  write('tests/live-dsh/windows-runtime-installation.spec.ts', 'export const liveInstall = true\n')

  return root
}

describe('changed-test-selection', () => {
  it('excludes live-only and stress tests by default and restores live suites when opted in', () => {
    const root = createFixtureWorkspace()
    const defaults = discoverCandidateTestFiles(root, {})
    expect(defaults).toContain('tests/live-dsh/harness.spec.ts')
    expect(defaults).not.toContain('tests/live-dsh/run.spec.ts')
    expect(defaults).not.toContain('tests/live-dsh/windows-runtime-installation.spec.ts')
    expect(defaults).not.toContain('apps/extension/src/heavy.stress.spec.ts')

    const installOptIn = discoverCandidateTestFiles(root, { DSH_LIVE_INSTALLATION: '1' })
    expect(installOptIn).toContain('tests/live-dsh/windows-runtime-installation.spec.ts')
    expect(installOptIn).not.toContain('tests/live-dsh/run.spec.ts')

    const liveOptIn = discoverCandidateTestFiles(root, { DSH_LIVE_SMOKE: '1' })
    expect(liveOptIn).toContain('tests/live-dsh/run.spec.ts')
    expect(liveOptIn).toContain('tests/live-dsh/windows-runtime-installation.spec.ts')
  })

  it('traces transitive workspace exports, CSS @import, vi.mock and generic vi.importActual', () => {
    const root = createFixtureWorkspace()
    const candidateTests = discoverCandidateTestFiles(root, {})

    expect(
      selectAffectedTests({ root, changedFiles: ['packages/domain/src/core.ts'], candidateTests }),
    ).toEqual(['apps/webview/src/view.spec.tsx'])

    expect(
      selectAffectedTests({ root, changedFiles: ['packages/domain/src/sub/extra.ts'], candidateTests }),
    ).toEqual(['apps/extension/src/mocked.spec.ts', 'apps/webview/src/router-bridge.spec.ts'])

    expect(
      selectAffectedTests({ root, changedFiles: ['apps/webview/src/styles/tokens.css'], candidateTests }),
    ).toEqual(['apps/webview/src/view.spec.tsx'])

    expect(selectAffectedTests({ root, changedFiles: ['README.md'], candidateTests })).toEqual([])
  })

  it('reruns all candidate tests on workspace or test configuration triggers', () => {
    const root = createFixtureWorkspace()
    const candidateTests = discoverCandidateTestFiles(root, {})

    expect(isForceRerunTrigger('vitest.config.ts')).toBe(true)
    expect(isForceRerunTrigger('packages/domain/package.json')).toBe(true)
    expect(isForceRerunTrigger('config/tsconfig.base.json')).toBe(true)
    expect(isForceRerunTrigger('apps/webview/src/view.tsx')).toBe(false)

    expect(selectAffectedTests({ root, changedFiles: ['vitest.config.ts'], candidateTests })).toEqual(
      candidateTests,
    )
  })

  it('reruns the suite when a setup file that runs before every test changes', async () => {
    const { default: config } = await import('../vitest.config.ts')
    const setupFiles = (config.test?.projects ?? []).flatMap((project) => {
      if (typeof project !== 'object' || !('test' in project)) return []
      const files = project.test?.setupFiles ?? []
      return typeof files === 'string' ? [files] : files
    })
    expect(setupFiles.length).toBeGreaterThan(0)
    for (const file of setupFiles) expect(isForceRerunTrigger(file)).toBe(true)
  })

  it('reruns the suite when a removed source can no longer be traced to its importers', () => {
    const root = createFixtureWorkspace()
    const candidateTests = discoverCandidateTestFiles(root, {})
    const deleted = 'packages/domain/src/core.ts'
    rmSync(join(root, deleted))

    expect(selectAffectedTests({ root, changedFiles: [deleted], candidateTests })).toEqual(candidateTests)
  })
})
