import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'

export const OFFLINE_LIVE_HARNESS_TESTS = [
  'tests/live-dsh/harness.spec.ts',
  'tests/live-dsh/managed-lock.spec.ts',
  'tests/live-dsh/paging.spec.ts',
  'tests/live-dsh/runtime-scope.spec.ts',
  'tests/live-dsh/runtime.spec.ts',
]

const IGNORED_DIRS = new Set([
  '.codegraph',
  '.git',
  '.test-workspace',
  'artifacts',
  'coverage',
  'dist',
  'media',
  'node_modules',
  'out',
])

const SCRIPT_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css']
const SPEC_FILE_RE = /\.spec\.tsx?$/u
const STRESS_SPEC_RE = /\.stress\.spec\.tsx?$/u

const toPosix = (value) => value.replaceAll('\\', '/')

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited with status ${String(result.status ?? 1)}`)
  }
  return result.stdout
    .split('\0')
    .filter((file) => file.length > 0)
    .map(toPosix)
}

/**
 * Match Vitest's GitVCSProvider file set: committed changes since `changedSince`,
 * staged changes, and unstaged/untracked working-tree files.
 */
export function listGitChangedFiles(root, changedSince) {
  const files = new Set()
  if (changedSince) {
    for (const file of runGit(root, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      `${changedSince}...HEAD`,
      '--',
    ]))
      files.add(file)
  }
  for (const file of runGit(root, ['diff', '--cached', '--name-only', '--no-renames', '-z'])) files.add(file)
  for (const file of runGit(root, ['ls-files', '--other', '--modified', '--exclude-standard', '-z']))
    files.add(file)
  return [...files]
}

/**
 * Setup files that `vitest.config.ts` runs before every file of a project. No
 * test imports them, so a change to one can only be traced by rerunning.
 */
export const VITEST_SETUP_FILES = [
  'apps/webview/src/test/reset-environment.ts',
  'apps/webview/src/test/locale-reset.ts',
  'tests/setup/reset-worker.ts',
]

export function isForceRerunTrigger(relativePath) {
  const normalized = toPosix(relativePath)
  const parts = normalized.split('/')
  const name = parts.at(-1) ?? ''
  if (
    VITEST_SETUP_FILES.includes(normalized) ||
    normalized === 'pnpm-lock.yaml' ||
    normalized === 'pnpm-workspace.yaml' ||
    normalized === 'scripts/test-changed.mjs' ||
    normalized === 'scripts/changed-test-selection.mjs'
  )
    return true
  if (name === 'package.json') return true
  if (/^vitest(?:\.[^/]+)?\.(?:[cm]?[jt]s)$/u.test(name)) return true
  if (/^vite\.config\.(?:[cm]?[jt]s)$/u.test(name)) return true
  if (/^tsconfig(?:\.[^/]+)?\.json$/u.test(name)) return true
  return false
}

function walkFiles(directory, onFile) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) walkFiles(fullPath, onFile)
    else if (entry.isFile()) onFile(fullPath)
  }
}

function isSpecFile(relativePath) {
  return SPEC_FILE_RE.test(relativePath) && !STRESS_SPEC_RE.test(relativePath)
}

/**
 * Discover test files matching the default projects in `vitest.config.ts`.
 */
export function discoverCandidateTestFiles(root, env = process.env) {
  const live = env.DSH_LIVE_SMOKE === '1'
  const liveInstallation = env.DSH_LIVE_INSTALLATION === '1'
  const results = new Set()
  const addRelative = (fullPath) => {
    const rel = toPosix(relative(root, fullPath))
    if (isSpecFile(rel)) results.add(rel)
  }

  for (const dir of ['apps/webview', 'apps/extension', 'packages', 'tests/vscode-e2e']) {
    walkFiles(join(root, dir), addRelative)
  }

  const testsDir = join(root, 'tests')
  if (existsSync(testsDir)) {
    for (const entry of readdirSync(testsDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.spec\.ts$/u.test(entry.name) && !STRESS_SPEC_RE.test(entry.name)) {
        results.add(posix.join('tests', entry.name))
      }
    }
  }

  if (live) {
    walkFiles(join(root, 'tests/live-dsh'), (fullPath) => {
      const rel = toPosix(relative(root, fullPath))
      if (/\.spec\.ts$/u.test(rel) && !STRESS_SPEC_RE.test(rel)) results.add(rel)
    })
  } else {
    for (const rel of OFFLINE_LIVE_HARNESS_TESTS) {
      if (existsSync(join(root, rel))) results.add(rel)
    }
    if (liveInstallation && existsSync(join(root, 'tests/live-dsh/windows-runtime-installation.spec.ts'))) {
      results.add('tests/live-dsh/windows-runtime-installation.spec.ts')
    }
  }

  return [...results].sort()
}

function createFileResolver() {
  const dirFiles = new Map()
  const resolvedCache = new Map()

  const isFile = (filePath) => {
    const dir = dirname(filePath)
    let files = dirFiles.get(dir)
    if (files === undefined) {
      files = new Set()
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isFile() || entry.isSymbolicLink()) files.add(entry.name)
        }
      } catch {
        // Directory does not exist or cannot be read.
      }
      dirFiles.set(dir, files)
    }
    return files.has(basename(filePath))
  }

  const resolveFileCandidate = (basePath) => {
    if (resolvedCache.has(basePath)) return resolvedCache.get(basePath)
    let hit
    if (isFile(basePath)) {
      hit = basePath
    } else {
      const ext = extname(basePath)
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs' || ext === '.jsx') {
        const stem = basePath.slice(0, -ext.length)
        const alternatives =
          ext === '.js'
            ? ['.ts', '.tsx', '.js', '.jsx']
            : ext === '.jsx'
              ? ['.tsx', '.jsx']
              : ext === '.mjs'
                ? ['.mts', '.mjs']
                : ['.cts', '.cjs']
        for (const candidateExt of alternatives) {
          const candidate = `${stem}${candidateExt}`
          if (isFile(candidate)) {
            hit = candidate
            break
          }
        }
      }
      if (!hit) {
        for (const candidateExt of RESOLVE_EXTENSIONS) {
          const candidate = `${basePath}${candidateExt}`
          if (isFile(candidate)) {
            hit = candidate
            break
          }
        }
      }
      if (!hit) {
        for (const candidateExt of RESOLVE_EXTENSIONS) {
          const candidate = join(basePath, `index${candidateExt}`)
          if (isFile(candidate)) {
            hit = candidate
            break
          }
        }
      }
    }
    resolvedCache.set(basePath, hit)
    return hit
  }

  return { resolveFileCandidate }
}

function readPackageExports(root, resolveFileCandidate) {
  const exact = new Map()
  const wildcards = []
  const register = (pkgDir, pkg) => {
    if (typeof pkg.name !== 'string' || pkg.name.length === 0) return
    const mapTarget = (target) => {
      if (typeof target !== 'string') return undefined
      const resolved = resolve(pkgDir, target)
      if (existsSync(resolved)) return resolved
      // Map built dist entrypoints back to workspace source when present.
      if (target.startsWith('./dist/')) {
        const sourceCandidate = resolve(pkgDir, target.replace(/^\.\/dist\//u, './src/'))
        const mapped = resolveFileCandidate(sourceCandidate)
        if (mapped) return mapped
      }
      return undefined
    }
    const resolveExportValue = (value) => {
      if (typeof value === 'string') return mapTarget(value)
      if (value && typeof value === 'object') {
        for (const key of ['development', 'types', 'import', 'default']) {
          const hit = resolveExportValue(value[key])
          if (hit) return hit
        }
      }
      return undefined
    }
    if (pkg.exports && typeof pkg.exports === 'object') {
      for (const [subpath, target] of Object.entries(pkg.exports)) {
        if (subpath.includes('*')) {
          const [prefix, suffix] = subpath.split('*')
          const rawTarget =
            typeof target === 'string'
              ? target
              : typeof target?.import === 'string'
                ? target.import
                : typeof target?.default === 'string'
                  ? target.default
                  : undefined
          if (rawTarget && rawTarget.includes('*')) {
            const [targetPrefix, targetSuffix] = rawTarget.split('*')
            wildcards.push({
              packageName: pkg.name,
              prefix: prefix.replace(/^\.\//u, ''),
              suffix,
              pkgDir,
              targetPrefix,
              targetSuffix,
            })
          }
          continue
        }
        const specifier = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//u, '')}`
        const resolved = resolveExportValue(target)
        if (resolved) exact.set(specifier, resolved)
      }
    } else if (typeof pkg.main === 'string') {
      const resolved = mapTarget(pkg.main)
      if (resolved) exact.set(pkg.name, resolved)
    }
  }

  for (const parent of ['packages', 'apps']) {
    const base = join(root, parent)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const pkgDir = join(base, entry.name)
      const pkgJsonPath = join(pkgDir, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      try {
        register(pkgDir, JSON.parse(readFileSync(pkgJsonPath, 'utf8')))
      } catch {
        // Ignore unreadable package manifests.
      }
    }
  }

  return { exact, wildcards }
}

function resolveSpecifier(specifier, importerAbsolute, exportsMap, resolveFileCandidate) {
  if (!specifier || specifier.startsWith('node:') || specifier.startsWith('virtual:')) return undefined
  const clean = specifier.split(/[?#]/u, 1)[0]
  if (!clean) return undefined
  if (clean.startsWith('.')) {
    return resolveFileCandidate(resolve(dirname(importerAbsolute), clean))
  }
  const exactHit = exportsMap.exact.get(clean)
  if (exactHit) return exactHit
  for (const rule of exportsMap.wildcards) {
    const head = `${rule.packageName}/${rule.prefix}`
    if (!clean.startsWith(head) || !clean.endsWith(rule.suffix)) continue
    const captured = clean.slice(head.length, clean.length - rule.suffix.length)
    const candidate = resolve(rule.pkgDir, `${rule.targetPrefix}${captured}${rule.targetSuffix}`)
    const hit = resolveFileCandidate(candidate)
    if (hit) return hit
    if (rule.targetSuffix) {
      const directoryHit = resolveFileCandidate(resolve(rule.pkgDir, `${rule.targetPrefix}${captured}`))
      if (directoryHit) return directoryHit
    }
  }
  return undefined
}

function extractVitestMockSpecifiers(source) {
  const specifiers = []
  const pattern = /\bvi\.(?:mock|doMock|unmock|doUnmock|importActual|importMock)\b/gu
  while (pattern.exec(source) !== null) {
    let cursor = pattern.lastIndex
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
    // Skip optional TypeScript generic type arguments such as `vi.importActual<{ ... }>(...)`.
    if (source[cursor] === '<') {
      let depth = 0
      while (cursor < source.length) {
        const ch = source[cursor]
        if (ch === "'" || ch === '"' || ch === '`') {
          cursor += 1
          while (cursor < source.length && source[cursor] !== ch) {
            if (source[cursor] === '\\') cursor += 1
            cursor += 1
          }
        } else if (ch === '=' && source[cursor + 1] === '>') {
          cursor += 2
          continue
        } else if (ch === '<') {
          depth += 1
        } else if (ch === '>') {
          depth -= 1
          if (depth === 0) {
            cursor += 1
            break
          }
        }
        cursor += 1
      }
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
    }
    if (source[cursor] !== '(') continue
    cursor += 1
    while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
    const quote = source[cursor]
    if (quote !== "'" && quote !== '"' && quote !== '`') continue
    cursor += 1
    const start = cursor
    let interpolated = false
    while (cursor < source.length && source[cursor] !== quote) {
      if (quote === '`' && source[cursor] === '$' && source[cursor + 1] === '{') {
        interpolated = true
        break
      }
      if (source[cursor] === '\\') cursor += 1
      cursor += 1
    }
    if (!interpolated && source[cursor] === quote) {
      specifiers.push(source.slice(start, cursor))
    }
  }
  return specifiers
}

function extractCssSpecifiers(source) {
  const specifiers = []
  const pattern = /@import\s+(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^)\s;]+))/gu
  let match
  while ((match = pattern.exec(source)) !== null) {
    const value = match[1] ?? match[2]
    if (value) specifiers.push(value)
  }
  return specifiers
}

export function extractModuleSpecifiers(filePath, source) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.css') return extractCssSpecifiers(source)
  if (!SCRIPT_EXTENSIONS.has(ext)) return []
  const specifiers = new Set()
  const info = ts.preProcessFile(source, true, true)
  for (const entry of info.importedFiles) specifiers.add(entry.fileName)
  for (const entry of info.referencedFiles) specifiers.add(entry.fileName)
  for (const entry of extractVitestMockSpecifiers(source)) specifiers.add(entry)
  return [...specifiers]
}

/**
 * Select default-suite test files affected by `changedFiles` using a static
 * reverse-dependency graph.
 */
export function selectAffectedTests({
  root,
  changedFiles,
  candidateTests = discoverCandidateTestFiles(root),
}) {
  const normalizedChanged = [...new Set(changedFiles.map(toPosix))]
  if (normalizedChanged.length === 0) return []
  const needsFullRun = normalizedChanged.some((file) => {
    if (isForceRerunTrigger(file)) return true
    // An absent source has no edges in the current graph, including the old side of a rename.
    const extension = extname(file).toLowerCase()
    return (
      (SCRIPT_EXTENSIONS.has(extension) || extension === '.css' || extension === '.json') &&
      !existsSync(resolve(root, file))
    )
  })
  if (needsFullRun) return [...candidateTests]

  const { resolveFileCandidate } = createFileResolver()
  const exportsMap = readPackageExports(root, resolveFileCandidate)
  const importedBy = new Map()
  const visited = new Set()
  const queue = []

  const enqueue = (absolutePath) => {
    if (visited.has(absolutePath)) return
    visited.add(absolutePath)
    queue.push(absolutePath)
  }

  for (const testRel of candidateTests) enqueue(resolve(root, testRel))

  for (let index = 0; index < queue.length; index += 1) {
    const currentAbsolute = queue[index]
    const ext = extname(currentAbsolute).toLowerCase()
    if (!SCRIPT_EXTENSIONS.has(ext) && ext !== '.css') continue
    let source
    try {
      source = readFileSync(currentAbsolute, 'utf8')
    } catch {
      continue
    }
    const currentRel = toPosix(relative(root, currentAbsolute))
    for (const specifier of extractModuleSpecifiers(currentAbsolute, source)) {
      const resolvedAbsolute = resolveSpecifier(specifier, currentAbsolute, exportsMap, resolveFileCandidate)
      if (!resolvedAbsolute) continue
      const resolvedRel = toPosix(relative(root, resolvedAbsolute))
      if (resolvedRel.startsWith('..') || resolvedRel.startsWith('node_modules/')) continue
      let importers = importedBy.get(resolvedRel)
      if (!importers) {
        importers = new Set()
        importedBy.set(resolvedRel, importers)
      }
      importers.add(currentRel)
      enqueue(resolvedAbsolute)
    }
  }

  const affectedFiles = new Set(normalizedChanged)
  const walkQueue = [...normalizedChanged]
  for (let index = 0; index < walkQueue.length; index += 1) {
    const file = walkQueue[index]
    const importers = importedBy.get(file)
    if (!importers) continue
    for (const importer of importers) {
      if (affectedFiles.has(importer)) continue
      affectedFiles.add(importer)
      walkQueue.push(importer)
    }
  }

  return candidateTests.filter((testRel) => affectedFiles.has(testRel))
}
