import { readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import type { DshBackend } from '../../packages/domain/src/backend.js'
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
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.5-rc.3'      # optional; defaults to the pinned runtime
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
      let unsubscribe = (): void => undefined
      try {
        const { backend } = runtime
        // The host-wide control stream only runs while a listener is attached,
        // exactly as the open view keeps it. Without this subscription the
        // queue snapshot can never arrive and the surface below would report an
        // unsupported capability for a healthy host.
        unsubscribe = backend.events.subscribe(() => undefined)
        const sessions = await backend.sessions.list()
        observed.push(`sessions.list ${sessions.items.length}`)
        // A Session's agent surfaces belong to the holder of its write lease:
        // while another DSH keeps a Session open — a server the developer runs,
        // for instance — the newest entries of the list refuse a read that needs
        // a resume with `gateway/internal` ("already owned by an active write
        // handle"). Nothing here writes, but sampling the newest Session blindly
        // reports a healthy host as broken, so the newest Sessions are probed
        // with the cheapest agent-scoped read and the first one that answers is
        // the one this run samples.
        const sampled = await selectAddressableSession(backend, sessions.items, unavailable)
        const sessionId = sampled.id

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
        await surface('sessions.list (search)', async () => {
          // The wire refuses a query over its 500 code-unit bound or one
          // carrying a NUL with `bad-request`, so sampling the bound itself
          // pins the client-side clamp to the host contract. A deployment may
          // also disable the session-query index outright; that refusal is
          // evidence too, not a mapping failure.
          try {
            const page = await backend.sessions.list({ search: 'x'.repeat(500) })
            return `${page.items.length} item(s)`
          } catch (error) {
            const appError = error as Partial<AppError>
            if (appError.context?.rpcCode === 'bad-request')
              throw new Error(`the host refused the query bound as bad-request: ${message(error)}`, {
                cause: error,
              })
            return `refused (${appError.context?.rpcCode ?? appError.code ?? 'unknown'})`
          }
        })
        await surface('plugins.inventory', async () => {
          const inventory = await backend.plugins.inventory()
          return `${inventory.entries.length}`
        })
        let presetRoster: Awaited<ReturnType<typeof backend.presets.list>> | undefined
        await surface('presets.list', async () => {
          const roster = await backend.presets.list()
          presetRoster = roster
          return `${roster.presets.length}`
        })
        if (presetRoster !== undefined && presetRoster.presets.length > 0) {
          const first = presetRoster.presets[0] as (typeof presetRoster.presets)[number]
          const read = backend.presets.read
          if (read === undefined) unavailable.push('presets.read skipped: adapter exposes no document reader')
          else
            await surface('presets.read', async () => {
              const document = await read.call(backend.presets, first.id)
              expect(document.id, `agentPreset.read must echo the requested id ${first.id}`).toBe(first.id)
              return `${document.trust} ${document.content.length} char(s)`
            })
        }
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
          await surface('models.listSessionModels', async () => {
            const catalog = await backend.models.listSessionModels(sessionId)
            expect(
              catalog.models.some(
                (model) =>
                  model.providerId === catalog.current.providerId && model.id === catalog.current.modelId,
              ) || !catalog.routable,
              `the session's current model ${catalog.current.providerId}/${catalog.current.modelId} must be in the routable catalog it was selected from`,
            ).toBe(true)
            return `${catalog.models.length} model(s) routable=${String(catalog.routable)} failure(s)=${catalog.failures.length}`
          })
          await surface('feedback.list', async () => {
            const items = await backend.feedback.list(sessionId)
            return `${items.length}`
          })
          // `fileReferences/list` answers [] both for "no match" and for a host
          // without the optional Remote. Sampling a name that exists in the
          // session's own working directory makes an empty answer a defect.
          const sample = await sampleWorkspaceEntry(
            backend,
            sessions.items,
            sampled.addressable ? sessionId : undefined,
            unavailable,
          )
          if (sample === undefined)
            unavailable.push('references.listFiles skipped: no readable session workspace')
          else
            await surface('references.listFiles', async () => {
              const candidates = await backend.references.listFiles(sample.sessionId, sample.name)
              expect(
                candidates.length,
                `@-file completion must list ${sample.name}, which exists in ${sample.cwd}`,
              ).toBeGreaterThan(0)
              return `${candidates.length} for ${sample.name} in ${sample.cwd}`
            })
          await surface('references.listSessions', async () => {
            const candidates = await backend.references.listSessions(sessionId, '')
            return `${candidates.length}`
          })
          // A user-invocable skill is not a registered command: the host answers
          // `commands/execute` with `undefined` for every line outside its
          // command directory, which is what makes `/skill-name args` a prompt
          // gesture instead of a command. A listed skill that the command
          // directory does not carry is the strongest sample; a name that is
          // absent from the directory proves the same host rule when the profile
          // ships no skills at all.
          const skills = await backend.skills.list(sessionId).catch(() => [])
          const commands = await backend.commands.list(sessionId).catch(() => [])
          const commandNames = new Set(commands.map((command) => command.name.trim().toLocaleLowerCase()))
          const listedSkill = skills.find(
            (skill) => skill.name.trim() !== '' && !commandNames.has(skill.name.trim().toLocaleLowerCase()),
          )
          const gestureName = listedSkill?.name.trim() ?? outOfDirectoryLine(commandNames)
          await surface('commands.execute', async () => {
            const line = `/${gestureName}`
            expect(
              await backend.commands.execute(sessionId, line),
              `${line} is outside the command directory, so the host must not report a command execution`,
            ).toEqual({ kind: 'unknown' })
            return `${line} unresolved${listedSkill === undefined ? ' (sampled name, profile ships no skill)' : ''}`
          })
          // The host publishes a queue cell only for a Session with a live
          // agent, so a running Session is the target that turns this surface
          // into evidence instead of a capability probe. A closed Session has
          // no pending queue for the host to publish at all.
          const queueTarget = sessions.items.find((item) => item.status === 'running')
          if (queueTarget === undefined)
            unavailable.push('sessions.listQueue skipped: no running session to sample')
          else
            await surface('sessions.listQueue', async () => {
              const queued = await backend.sessions.listQueue(queueTarget.id)
              return `${queued.length} for the running session`
            })
        }

        expect(unexpected, 'no read-only surface may fail protocol or mapping validation').toEqual([])
        // A fresh isolated DSH_HOME has no session, so the session-scoped
        // reads are legitimately skipped. Once a session exists, the queue
        // sample adds the twelfth observation.
        expect(observed.length).toBeGreaterThanOrEqual(sessionId === undefined ? 11 : 12)
      } finally {
        unsubscribe()
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

/**
 * A command-line token no registered command can own: the probe still exercises
 * the host's own directory resolution, and never a name this extension guessed.
 */
function outOfDirectoryLine(commandNames: ReadonlySet<string>): string {
  let index = 0
  for (;;) {
    const candidate = `dsh-live-surface-probe-${index}`
    if (!commandNames.has(candidate)) return candidate
    index += 1
  }
}

/** How many of the newest Sessions the addressability walk may probe. */
const SESSION_PROBE_LIMIT = 8

/** The Session this run samples, and whether a probe answered for it. */
interface SampledSession {
  readonly id: string | undefined
  readonly addressable: boolean
}

/**
 * Pick the Session every agent-scoped surface below reads. Those surfaces
 * belong to the holder of the Session's write lease, so a profile whose newest
 * Session is open in a DSH the developer runs refuses them with
 * `gateway/internal` even though every call here is a read. The walk probes the
 * newest Sessions with the cheapest agent-scoped read and keeps the first one
 * that answers; a host without the command directory answers every candidate
 * with `CAPABILITY_UNAVAILABLE`, which is not a lease signal, so the walk stops
 * there. When every candidate refuses, the newest Session is sampled anyway: a
 * genuine mapping failure has to stay a failure instead of being explained
 * away, and only an environment where a foreign DSH holds every recent Session
 * turns that into a red run.
 */
async function selectAddressableSession(
  backend: DshBackend,
  sessions: readonly SessionSummary[],
  notes: string[],
): Promise<SampledSession> {
  for (const candidate of sessions.slice(0, SESSION_PROBE_LIMIT)) {
    const refusal = await probeSession(backend, candidate.id)
    if (refusal === undefined) return { id: candidate.id, addressable: true }
    notes.push(`session ${candidate.id} skipped: ${refusal}`)
  }
  return { id: sessions[0]?.id, addressable: false }
}

/**
 * `commands/list` is the cheapest read that makes the host resume a Session,
 * which is exactly the step a foreign lease refuses. The refusal detail comes
 * back as a string so the caller can skip that candidate and report why; a
 * missing command directory is not a refusal, since it would decide every
 * Session the same way.
 */
async function probeSession(backend: DshBackend, sessionId: string): Promise<string | undefined> {
  try {
    await backend.commands.list(sessionId)
  } catch (error) {
    const code = (error as Partial<AppError>).code
    if (code !== 'CAPABILITY_UNAVAILABLE')
      return `agent surfaces refused [${code ?? 'no-code'}]: ${message(error)}`
  }
  return undefined
}

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

/** Pick a real entry from a Session workspace the host will answer for. */
async function sampleWorkspaceEntry(
  backend: DshBackend,
  sessions: readonly SessionSummary[],
  preferredId: string | undefined,
  notes: string[],
): Promise<{ readonly sessionId: string; readonly cwd: string; readonly name: string } | undefined> {
  // The Session the walk already answered for is offered first; without one,
  // every session of the profile is offered, not a fixed prefix: old sessions
  // point at deleted directories and subagent children carry no cwd, so a
  // bounded slice can leave the picker assertion without any sample at all.
  // Sessions sharing a workspace are read once, and a workspace only counts as
  // a sample when its own Session answers the probe, so a foreign lease cannot
  // turn the picker assertion into a failure it has nothing to do with.
  const ordered =
    preferredId === undefined
      ? sessions
      : [
          ...sessions.filter((session) => session.id === preferredId),
          ...sessions.filter((session) => session.id !== preferredId),
        ]
  const visited = new Set<string>()
  for (const session of ordered) {
    const cwd = session.cwd
    if (cwd === undefined || visited.has(cwd)) continue
    visited.add(cwd)
    const entries = await readdir(cwd).catch(() => [] as string[])
    const name = entries.find((entry) => !entry.startsWith('.') && !EXCLUDED_ENTRIES.has(entry))
    if (name === undefined) continue
    const refusal = session.id === preferredId ? undefined : await probeSession(backend, session.id)
    if (refusal === undefined) return { sessionId: session.id, cwd, name }
    notes.push(`session ${session.id} skipped: ${refusal}`)
  }
  return undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
