import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const docsRoot = path.join(root, 'docs')
const expectedDocs = new Set([
  'README.md',
  'architecture.md',
  'dsh-contract.md',
  'capability-matrix.md',
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
  ...['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'AGENTS.md'].map((name) =>
    path.join(root, name),
  ),
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
      if (/^(?:https?:|mailto:|codex:)/iu.test(target)) continue
      const pathname = decodeURIComponent(target.split('#', 1)[0])
      if (pathname === '') continue
      const resolved = path.resolve(path.dirname(file), pathname)
      if (!existsSync(resolved)) errors.push(`${name}:${index + 1}: broken local link ${target}`)
    }
  }
  if (name !== 'docs/dsh-contract.md' && name !== 'apps/extension/CHANGELOG.md') {
    if (/\b\d+\.\d+\.\d+-(?:rc|alpha)\.\d+\b/u.test(source))
      errors.push(`${name}: DSH version belongs in docs/dsh-contract.md or the release changelog`)
  }
  if (name.startsWith('docs/') && name !== 'docs/dsh-contract.md') {
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
  const supported = [...versionsBlock.matchAll(/^\s*'(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)'/gmu)].map(
    (match) => match[1],
  )
  const documented = new Set(
    [...versionTable.matchAll(/`(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)`/gu)].map((match) => match[1]),
  )
  for (const version of supported) {
    if (!documented.has(version)) errors.push(`docs/dsh-contract.md: missing ${version}`)
  }
}
const installerVersion = code.match(
  /LATEST_PUBLISHED_DSH_VERSION = '(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)'/u,
)?.[1]
const documentedInstaller = contract.match(/@deepseek-ai\/dsh@(\d+\.\d+\.\d+-(?:rc|alpha)\.\d+)/u)?.[1]
if (installerVersion === undefined || documentedInstaller !== installerVersion)
  errors.push('docs/dsh-contract.md: installer default differs from code')

const matrix = readFileSync(path.join(docsRoot, 'capability-matrix.md'), 'utf8')
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
    .sort()
if (JSON.stringify(localTargets(readme)) !== JSON.stringify(localTargets(chineseReadme)))
  errors.push('README translations link to different local documentation')

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `Documentation checks passed (${seen.size} Markdown files, ${ids.length} capabilities).\n`,
  )
}
