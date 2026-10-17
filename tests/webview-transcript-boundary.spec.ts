import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(root, 'apps/webview/src')
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'test') return []
    const target = path.join(dir, entry.name)
    return entry.isDirectory()
      ? sources(target)
      : /\.tsx?$/.test(entry.name) && !entry.name.includes('.spec.')
        ? [target]
        : []
  })
}

describe('Webview transcript ownership', () => {
  it('has no durable replay engine, raw history route callers or production dependency on legacy fixtures', () => {
    for (const name of [
      'gap-heal',
      'history-ledger',
      'history-replay',
      'history-compaction-index',
      'pending-open',
    ])
      expect(fs.existsSync(path.join(sourceRoot, 'app/store', `${name}.ts`)), name).toBe(false)
    for (const file of sources(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8')
      expect(source, path.relative(root, file)).not.toMatch(/\bSessionHistoryEvent\b/)
      expect(source, path.relative(root, file)).not.toMatch(
        /\breduceTimeline(?:Batch)?\b|\bmergeHistory\b|\borderPendingReplayMessages\b/,
      )
      expect(source, path.relative(root, file)).not.toMatch(/from\s+['"][^'"]*\/(?:test|domain-fixture)\//)
      expect(source, path.relative(root, file)).not.toMatch(/type:\s*['"]session\.history['"]/)
    }
    expect(fs.readFileSync(path.join(sourceRoot, 'app/store/types.ts'), 'utf8')).not.toContain(
      'SessionHistoryEvent',
    )
  })
})
