import { readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ExportFileSystem } from '../../packages/dsh-adapter/src/repositories/export-repository.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

const MAX_HISTORY_PAGES = 4
/** How many of the newest registry rows may be skipped before giving up on finding history. */
const SESSION_SAMPLE_LIMIT = 5
/** A ZIP archive always opens with a local file header, never a text or error body. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]

/**
 * Live export evidence: export a real session through the adapter that the
 * Extension Host builds, over the real 0.1.6 event vocabulary. The JSON export
 * walks `session.history` backwards to the start of the session, so it is also
 * the only place where the paging contract is exercised end to end; the ZIP
 * export is the Host's own archive route.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'   # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/export.spec.ts
 *
 * The destination is a temporary directory this spec owns and removes; nothing
 * is written next to the user's sessions and no session content is printed.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH session export', () => {
  it(
    'exports a real session as JSON and as the Host ZIP archive',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-vscode-live-export-'))
      const runtime = await startManagedRuntime({ exportFileSystem: nodeExportFileSystem })
      try {
        const { backend } = runtime
        const sessions = await backend.sessions.list()
        expect(sessions.items.length, 'the live runtime must expose at least one session').toBeGreaterThan(0)

        const target = await pickSessionWithHistory(backend, sessions.items)
        expect(target, 'a sampled session must carry exportable history').toBeDefined()
        if (target === undefined) return

        const jsonDestination = path.join(root, 'session.json')
        await backend.exports.exportSession(
          {
            sessionId: target.id,
            format: 'json',
            includeAttachments: true,
            includeReasoning: true,
          },
          jsonDestination,
        )

        const rows = JSON.parse(await readFile(jsonDestination, 'utf8')) as readonly Record<string, unknown>[]
        console.log(`[dsh-live-export] json rows=${rows.length} bytes=${(await stat(jsonDestination)).size}`)

        expect(rows.length, 'the JSON export must contain the session history').toBeGreaterThan(0)
        const sequences = rows.flatMap((row) => {
          const event = row.event as { seq?: unknown } | undefined
          return typeof event?.seq === 'number' ? [event.seq] : []
        })
        // The export walks history backwards and re-orders it, so the durable
        // sequence has to come out strictly increasing without duplicates.
        expect(sequences.length).toBe(rows.length)
        expect(new Set(sequences).size).toBe(sequences.length)
        expect([...sequences].sort((left, right) => left - right)).toEqual(sequences)
        // A row this build cannot project stays in the export as a marked
        // record instead of failing the whole session.
        const unreadable = rows.filter((row) => (row.event as { unreadable?: unknown }).unreadable === true)
        console.log(`[dsh-live-export] unreadable=${unreadable.length}`)

        const zipDestination = path.join(root, 'session.zip')
        await backend.exports.exportSession(
          {
            sessionId: target.id,
            format: 'zip',
            includeAttachments: true,
            includeReasoning: true,
          },
          zipDestination,
        )
        const archive = await readFile(zipDestination)
        console.log(`[dsh-live-export] zip bytes=${archive.byteLength}`)
        expect([...archive.subarray(0, ZIP_SIGNATURE.length)]).toEqual(ZIP_SIGNATURE)
        expect(archive.byteLength).toBeGreaterThan(ZIP_SIGNATURE.length)

        const markdownDestination = path.join(root, 'session.md')
        await backend.exports.exportSession(
          {
            sessionId: target.id,
            format: 'markdown',
            includeAttachments: true,
            includeReasoning: true,
          },
          markdownDestination,
        )
        const markdown = await readFile(markdownDestination, 'utf8')
        const userSection = markdownSection(markdown, 'user/message')
        console.log(
          `[dsh-live-export] markdown bytes=${markdown.length} userSection=${userSection === undefined ? 'none' : String(userSection.length)}`,
        )
        if (target.userTurns > 0) {
          expect(userSection, 'the Markdown export must render the session user turn').toBeDefined()
          // A message row is prose, not the raw durable record the JSON export
          // deliberately keeps.
          if (userSection !== undefined) {
            expect(userSection.startsWith('{')).toBe(false)
            expect(userSection.trim().length).toBeGreaterThan(0)
          }
        }
        // A real session is mostly host bookkeeping, and the readable shape
        // leaves those rows to the JSON export instead of turning them into
        // JSON blobs. The sampled session carries them, so this is not vacuous.
        const bookkeepingRows = rows.filter((row) =>
          BOOKKEEPING_ROW_TYPES.has((row.event as { type?: string }).type ?? ''),
        )
        console.log(
          `[dsh-live-export] bookkeepingRows=${bookkeepingRows.length}/${rows.length} markdownBytes=${markdown.length}`,
        )
        expect(bookkeepingRows.length, 'a real session must carry host bookkeeping rows').toBeGreaterThan(0)
        for (const type of BOOKKEEPING_ROW_TYPES)
          expect(markdown, `the Markdown export must not render a ${type} record`).not.toContain(
            `### ${type}`,
          )
      } finally {
        await runtime.stop()
        await rm(root, { recursive: true, force: true })
        const released = !(await canConnect(runtime.snapshot.port))
        console.log(
          `[dsh-live-export] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/** Host bookkeeping row types the readable export shape leaves out. */
const BOOKKEEPING_ROW_TYPES = new Set([
  'agent/inbox/spliced',
  'assistant/attempt',
  'request/header',
  'session/end-seed',
  'step/end',
  'step/start',
  'turn/start',
  'web/deepseek-search-llm-request',
])

/** The registry is the user's own, so its newest rows may be blank sessions. */
async function pickSessionWithHistory(
  backend: Awaited<ReturnType<typeof startManagedRuntime>>['backend'],
  sessions: readonly { readonly id: string }[],
): Promise<{ readonly id: string; readonly userTurns: number } | undefined> {
  let fallback: { readonly id: string; readonly userTurns: number } | undefined
  for (const candidate of sessions.slice(0, SESSION_SAMPLE_LIMIT)) {
    let beforeSequence: number | undefined
    let rows = 0
    let userTurns = 0
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const result = await backend.sessions.history(candidate.id, beforeSequence)
      rows += result.events.length
      userTurns += result.events.filter((row) => row.event.type === 'message.user').length
      if (!result.hasMore) break
      const oldest = result.beforeSequence ?? Math.min(...result.events.map((row) => row.sequence))
      if (!Number.isFinite(oldest) || (beforeSequence !== undefined && oldest >= beforeSequence)) break
      beforeSequence = oldest
    }
    // The Markdown assertion needs a readable user turn, so prefer one; a
    // session that only carries metadata still exercises the other formats.
    if (userTurns > 0) return { id: candidate.id, userTurns }
    if (rows > 0 && fallback === undefined) fallback = { id: candidate.id, userTurns: 0 }
  }
  return fallback
}

function markdownSection(markdown: string, type: string): string | undefined {
  const heading = `### ${type}\n\n`
  const start = markdown.indexOf(heading)
  if (start < 0) return undefined
  const body = markdown.slice(start + heading.length)
  const next = body.indexOf('\n\n### ')
  return next < 0 ? body : body.slice(0, next)
}

/** The Extension Host's authorized file system, backed by the spec's temp directory. */
const nodeExportFileSystem: ExportFileSystem = {
  stat,
  rename: async (source, destination, overwrite = false) => {
    if (overwrite) await unlink(destination).catch(() => undefined)
    await rename(source, destination)
  },
  unlink,
  writeFile: (filePath, data) => writeFile(filePath, data),
}
