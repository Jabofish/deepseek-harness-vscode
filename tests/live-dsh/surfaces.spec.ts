import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import type { AppError } from '../../packages/domain/src/errors.js'
import type { SessionSummary } from '../../packages/domain/src/sessions.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime } from './harness.js'

/**
 * Live read-only surface evidence for the pinned runtime build. Every call
 * below goes through the real versioned adapters, so a DTO that only matches
 * the checked-in fixtures fails here. Nothing is mutated: no prompt is sent and
 * no session is created.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.1'      # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/surfaces.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never touched.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH read-only surfaces', () => {
  it(
    'maps every read-only repository surface of the real runtime',
    async () => {
      const runtime = await startManagedRuntime()
      const observed: string[] = []
      const unavailable: string[] = []
      const unexpected: string[] = []
      try {
        const { backend } = runtime
        const sessions = await backend.sessions.list()
        const sessionId = sessions.items[0]?.id
        observed.push(`sessions.list ${sessions.items.length}`)

        const surface = async (name: string, call: () => Promise<string>): Promise<void> => {
          try {
            observed.push(`${name} ${await call()}`)
          } catch (error) {
            const code = (error as Partial<AppError>).code
            if (code === 'CAPABILITY_UNAVAILABLE') unavailable.push(`${name} unavailable: ${message(error)}`)
            else unexpected.push(`${name} failed [${code ?? 'no-code'}]: ${message(error)}`)
          }
        }

        await surface('workspaces.list', async () => {
          const workspaces = await backend.workspaces.list()
          return `${workspaces.length}`
        })
        await surface('workspaces.listArchivedSessionIds', async () => {
          const archived = await backend.workspaces.listArchivedSessionIds()
          return `${archived.length}`
        })
        await surface('models.listProviders', async () => {
          const providers = await backend.models.listProviders()
          return `${providers.length}`
        })
        await surface('models.listModels', async () => {
          const models = await backend.models.listModels()
          return `${models.length}`
        })
        await surface('plugins.inventory', async () => {
          const inventory = await backend.plugins.inventory()
          return `${inventory.entries.length}`
        })
        await surface('presets.list', async () => {
          const roster = await backend.presets.list()
          return `${roster.presets.length}`
        })
        await surface('settings.schema', async () => {
          const schema = await backend.settings.schema()
          return `${schema.fields.length} field(s) in ${schema.namespaces.length} namespace(s)`
        })
        await surface('settings.read', async () => {
          const value = await backend.settings.read()
          return `${Object.keys(value).length} namespace(s)`
        })
        await surface('skills.list', async () => {
          const skills = await backend.skills.list(sessionId)
          return `${skills.length}`
        })
        await surface('commands.list', async () => {
          const commands = await backend.commands.list(sessionId)
          return `${commands.length}`
        })

        if (sessionId !== undefined) {
          await surface('sessions.get', async () => {
            const detail = await backend.sessions.get(sessionId)
            return `${detail.history?.length ?? 0} history row(s)`
          })
          await surface('sessions.history', async () => {
            const page = await backend.sessions.history(sessionId)
            return `${page.events.length} event(s) hasMore=${String(page.hasMore)}`
          })
          await surface('goals.list', async () => {
            const goals = await backend.goals.list(sessionId)
            return `${goals.length}`
          })
          await surface('jobs.list', async () => {
            const jobs = await backend.jobs.list(sessionId)
            return `${jobs.length}`
          })
          await surface('subagents.list', async () => {
            const catalog = await backend.subagents.list(sessionId)
            return `${catalog.entries.length}`
          })
          // `fileReferences/list` answers [] both for "no match" and for a host
          // without the optional Remote. Sampling a name that exists in the
          // session's own working directory makes an empty answer a defect.
          const sample = await sampleWorkspaceEntry(sessions.items)
          let fileReferenceCount: number | undefined
          await surface('references.listFiles', async () => {
            if (sample === undefined) return 'no readable session workspace to sample'
            const candidates = await backend.references.listFiles(sample.sessionId, sample.name)
            fileReferenceCount = candidates.length
            return `${candidates.length} for ${sample.name} in ${sample.cwd}`
          })
          if (sample !== undefined)
            expect(
              fileReferenceCount,
              `@-file completion must list ${sample.name}, which exists in ${sample.cwd}`,
            ).toBeGreaterThan(0)
          await surface('references.listSessions', async () => {
            const candidates = await backend.references.listSessions(sessionId, '')
            return `${candidates.length}`
          })
          await surface('sessions.listQueue', async () => {
            const queued = await backend.sessions.listQueue(sessionId)
            return `${queued.length}`
          })
        }

        expect(unexpected, 'no read-only surface may fail protocol or mapping validation').toEqual([])
        expect(observed.length).toBeGreaterThanOrEqual(12)
      } finally {
        await runtime.stop()
        const released = !(await canConnect(runtime.snapshot.port))
        for (const step of runtime.steps) console.log(`[dsh-live-surfaces] ${step}`)
        for (const line of observed) console.log(`[dsh-live-surfaces] ok ${line}`)
        for (const line of unavailable) console.log(`[dsh-live-surfaces] skipped ${line}`)
        for (const line of unexpected) console.log(`[dsh-live-surfaces] FAILED ${line}`)
        console.log(
          `[dsh-live-surfaces] managed stop port ${runtime.snapshot.port} released=${String(released)}`,
        )
        expect(released, `loopback port ${runtime.snapshot.port} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/** Runtime defaults for directories the local file-reference provider skips. */
const EXCLUDED_ENTRIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
])

/** Pick a real entry from a session workspace so the query cannot be vacuous. */
async function sampleWorkspaceEntry(
  sessions: readonly SessionSummary[],
): Promise<{ readonly sessionId: string; readonly cwd: string; readonly name: string } | undefined> {
  for (const session of sessions.slice(0, 8)) {
    if (session.cwd === undefined) continue
    const entries = await readdir(session.cwd).catch(() => [] as string[])
    const name = entries.find((entry) => !entry.startsWith('.') && !EXCLUDED_ENTRIES.has(entry))
    if (name !== undefined) return { sessionId: session.id, cwd: session.cwd, name }
  }
  return undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
