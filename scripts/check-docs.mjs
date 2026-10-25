import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const docsRoot = path.join(root, 'docs')
const expectedDocs = new Set([
  'README.md',
  'architecture.md',
  'architecture.en.md',
  'dsh-contract.md',
  'dsh-contract.en.md',
  'capability-matrix.md',
  'capability-matrix.en.md',
  'ui.md',
  'quality.md',
])
const errors = []

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(absolute)
    return entry.isFile() && entry.name.endsWith('.md') ? [absolute] : []
  })
}

const files = [
  ...[
    'README.md',
    'README.zh-CN.md',
    'CHANGELOG.md',
    '.github/CONTRIBUTING.md',
    '.github/CONTRIBUTING.zh-CN.md',
    'AGENTS.md',
    'CLAUDE.md',
    'packages/dsh-editor-bridge/README.md',
  ].map((name) => path.join(root, name)),
  ...markdownFiles(docsRoot),
  ...markdownFiles(path.join(root, 'apps', 'extension')),
  ...markdownFiles(path.join(root, '.github')),
  ...markdownFiles(path.join(root, 'tests')),
]
const relative = (absolute) => path.relative(root, absolute).replaceAll('\\', '/')
const seen = new Set()

for (const file of files) {
  if (seen.has(file)) continue
  seen.add(file)
  const name = relative(file)
  const source = readFileSync(file, 'utf8')
  const lines = source.split(/\r?\n/u)
  let fenced = false
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const target = match[1].replace(/^<|>$/gu, '')
      const linkedPath = decodeURIComponent(target.split(/[?#]/u, 1)[0])
      if (
        /^docs\/capability-matrix(?:\.en)?\.md$/u.test(name) &&
        !/\.(?:md|mdx|rst|txt|html?|pdf)$/iu.test(linkedPath) &&
        (/\.(?:[cm]?[jt]sx?|jsonc?|css|scss|less|py|rs|go|sh|ps1)$/iu.test(linkedPath) ||
          /(?:^|\/)(?:apps|packages|src|tests|scripts)(?:\/|$)/u.test(linkedPath))
      )
        errors.push(`${name}:${index + 1}: describe capabilities without source or test links`)
      if (/^(?:https?:|mailto:|codex:)/iu.test(target)) continue
      const pathname = decodeURIComponent(target.split('#', 1)[0])
      if (pathname === '') continue
      const resolved = path.resolve(path.dirname(file), pathname)
      if (!existsSync(resolved)) errors.push(`${name}:${index + 1}: broken local link ${target}`)
    }
  }
  if (!/^docs\/dsh-contract(?:\.en)?\.md$/u.test(name) && name !== 'apps/extension/CHANGELOG.md') {
    if (/\b\d+\.\d+\.\d+-(?:rc|alpha)\.\d+\b/u.test(source))
      errors.push(`${name}: DSH version belongs in docs/dsh-contract.md or the release changelog`)
  }
  if (name.startsWith('docs/') && !/^docs\/dsh-contract(?:\.en)?\.md$/u.test(name)) {
    if (/^#{2,}\s+(?:\d{4}[-/]|证据补充|审计记录|本次变更)/mu.test(source))
      errors.push(`${name}: history-like section in a current specification`)
  }
}

const actualDocs = markdownFiles(docsRoot).map((file) => relative(file).slice('docs/'.length))
for (const name of actualDocs) if (!expectedDocs.has(name)) errors.push(`docs/${name}: unowned document`)
for (const name of expectedDocs)
  if (!actualDocs.includes(name)) errors.push(`docs/${name}: missing owned document`)

const contract = readFileSync(path.join(docsRoot, 'dsh-contract.md'), 'utf8')
const code = readFileSync(path.join(root, 'packages/dsh-adapter/src/contracts.ts'), 'utf8')
const versionTable = contract.split('## 版本身份与 wire 家族')[1]?.split('### 未知版本')[0]
const versionsBlock = code.match(/export const SUPPORTED_DSH_VERSIONS = \[([\s\S]*?)\] as const/u)?.[1]
if (versionsBlock === undefined || versionTable === undefined)
  errors.push('cannot read supported versions or the contract version table')
else {
  const supported = [
    ...versionsBlock.matchAll(/^\s*'(\d+\.\d+\.\d+-(?:(?:rc|alpha)\.\d+|master\.[0-9a-f]{40}))'/gmu),
  ].map((match) => match[1])
  const documented = new Set(
    [...versionTable.matchAll(/`(\d+\.\d+\.\d+-(?:(?:rc|alpha)\.\d+|master\.[0-9a-f]{40}))`/gu)].map(
      (match) => match[1],
    ),
  )
  for (const version of supported) {
    if (!documented.has(version)) errors.push(`docs/dsh-contract.md: missing ${version}`)
  }
}
const publishedVersion = code.match(
  /LATEST_PUBLISHED_DSH_VERSION = '(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)'/u,
)?.[1]
const installerVersion = code.match(/DEFAULT_INSTALL_DSH_VERSION = '(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)'/u)?.[1]
const documentedPublished = contract.match(
  /最新发布包为 `@deepseek-ai\/dsh@(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)`/u,
)?.[1]
const documentedInstaller = contract.match(
  /引导安装默认包为 `@deepseek-ai\/dsh@(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)`/u,
)?.[1]
if (publishedVersion === undefined || documentedPublished !== publishedVersion)
  errors.push('docs/dsh-contract.md: latest published version differs from code')
if (installerVersion === undefined || documentedInstaller !== installerVersion)
  errors.push('docs/dsh-contract.md: installer default differs from code')

const matrix = readFileSync(path.join(docsRoot, 'capability-matrix.md'), 'utf8')
if (/\|\s*(?:已有证据|验收缺口|测试入口)\s*\|/u.test(matrix))
  errors.push('docs/capability-matrix.md: keep evidence and test inventories out of capability tables')
const rows = [...matrix.matchAll(/^\|\s*([A-Z]+-\d+)\s*\|.*\|\s*(DONE|PARTIAL|TODO)\s*\|\s*$/gmu)]
if (rows.length < 45)
  errors.push(`docs/capability-matrix.md: expected at least 45 capability rows, found ${rows.length}`)
const ids = rows.map((match) => match[1])
if (new Set(ids).size !== ids.length) errors.push('docs/capability-matrix.md: duplicate capability ID')

const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const chineseReadme = readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')
const headings = (source) => [...source.matchAll(/^## /gmu)].length
if (headings(readme) !== headings(chineseReadme))
  errors.push('README translations have different section counts')
const localTargets = (source) =>
  [...source.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1])
    .filter((target) => !/^(?:https?:|mailto:)/iu.test(target))
    .map((target) => target.replace(/\.(?:en|zh-CN)\.md(?=$|#)/u, '.md'))
    .sort()
if (JSON.stringify(localTargets(readme)) !== JSON.stringify(localTargets(chineseReadme)))
  errors.push('README translations link to different local documentation')

const contributing = readFileSync(path.join(root, '.github', 'CONTRIBUTING.md'), 'utf8')
const chineseContributing = readFileSync(path.join(root, '.github', 'CONTRIBUTING.zh-CN.md'), 'utf8')
if (headings(contributing) !== headings(chineseContributing))
  errors.push('CONTRIBUTING translations have different section counts')
if (JSON.stringify(localTargets(contributing)) !== JSON.stringify(localTargets(chineseContributing)))
  errors.push('CONTRIBUTING translations link to different local documentation')
const shellExamples = (source) =>
  [...source.matchAll(/```sh\r?\n([\s\S]*?)```/gu)].map((match) => match[1].replaceAll('\r\n', '\n'))
if (JSON.stringify(shellExamples(contributing)) !== JSON.stringify(shellExamples(chineseContributing)))
  errors.push('CONTRIBUTING translations have different shell examples')
const pnpmCommands = (source) => [...new Set(source.match(/`pnpm [^`\n]+`/gu))].sort()
if (JSON.stringify(pnpmCommands(contributing)) !== JSON.stringify(pnpmCommands(chineseContributing)))
  errors.push('CONTRIBUTING translations have different pnpm commands')

const englishMatrix = readFileSync(path.join(docsRoot, 'capability-matrix.en.md'), 'utf8')
const capabilityStates = (source) =>
  [...source.matchAll(/^\|\s*([A-Z]+-\d+)\s*\|.*\|\s*(DONE|PARTIAL|TODO)\s*\|\s*$/gmu)]
    .map((match) => `${match[1]}:${match[2]}`)
    .sort()
if (JSON.stringify(capabilityStates(matrix)) !== JSON.stringify(capabilityStates(englishMatrix)))
  errors.push('Capability matrix translations have different IDs or statuses')

const versionFacts = (source) => [...new Set(source.match(/\b\d+\.\d+\.\d+-(?:rc|alpha)\.\d+\b/gu))].sort()
const pinnedSources = (source) => [...new Set(source.match(/\b[0-9a-f]{40}\b/gu))].sort()
const remoteTargets = (source) =>
  [...source.matchAll(/\]\((https?:\/\/[^)\s]+)\)/gu)].map((match) => match[1]).sort()
// The architecture overview and detailed specification have different structures.
for (const topic of ['dsh-contract', 'capability-matrix']) {
  const chinese = readFileSync(path.join(docsRoot, `${topic}.md`), 'utf8')
  const english = readFileSync(path.join(docsRoot, `${topic}.en.md`), 'utf8')
  if (headings(chinese) !== headings(english))
    errors.push(`${topic}: translations have different section counts`)
  if (JSON.stringify(localTargets(chinese)) !== JSON.stringify(localTargets(english)))
    errors.push(`${topic}: translations link to different local documentation`)
  if (JSON.stringify(versionFacts(chinese)) !== JSON.stringify(versionFacts(english)))
    errors.push(`${topic}: translations have different version identities`)
  if (JSON.stringify(pinnedSources(chinese)) !== JSON.stringify(pinnedSources(english)))
    errors.push(`${topic}: translations have different pinned source commits`)
  if (JSON.stringify(remoteTargets(chinese)) !== JSON.stringify(remoteTargets(english)))
    errors.push(`${topic}: translations link to different remote sources`)
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Documentation checks passed (${seen.size} Markdown files, ${ids.length} capabilities).\n`,
  )
}
