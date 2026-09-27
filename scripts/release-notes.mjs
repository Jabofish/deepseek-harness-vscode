import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionRoot = path.join(repositoryRoot, 'apps', 'extension')
const manifest = JSON.parse(readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'))
const tag = process.argv[2]
const version = manifest.version

if (tag !== `v${version}`) {
  throw new Error(`Release tag ${tag ?? '(missing)'} does not match extension version ${version}.`)
}

const lines = readFileSync(path.join(extensionRoot, 'CHANGELOG.md'), 'utf8').split(/\r?\n/u)
const start = lines.findIndex((line) => line === `## ${version}`)
if (start < 0) throw new Error(`CHANGELOG.md has no ${version} section.`)

const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
const section = lines.slice(start + 1, end < 0 ? undefined : end)
const bullets = []
for (const line of section) {
  if (line.startsWith('- ')) {
    bullets.push(line.slice(2).trim())
  } else if (/^ {2}\S/u.test(line) && bullets.length > 0) {
    bullets[bullets.length - 1] += ` ${line.trim()}`
  }
}

const englishBullets = bullets.filter((bullet) => !/\p{Script=Han}/u.test(bullet))
const highlights = (englishBullets.length > 0 ? englishBullets : bullets).slice(0, 5)
if (highlights.length === 0) throw new Error(`CHANGELOG.md has no release notes for ${version}.`)

const repositoryUrl = manifest.repository.url.replace(/\.git$/u, '')
process.stdout.write(
  `## ${version}\n\n${highlights.map((bullet) => `- ${bullet}`).join('\n')}\n\n` +
    `[Detailed changelog](${repositoryUrl}/blob/${tag}/apps/extension/CHANGELOG.md)\n`,
)
