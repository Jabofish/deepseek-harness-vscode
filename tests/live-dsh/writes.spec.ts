import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentConfiguration } from '../../packages/domain/src/models.js'
import type { DshSettingsSchema } from '../../packages/domain/src/advanced.js'
import type { DshBackend } from '../../packages/domain/src/backend.js'
import type { AppError } from '../../packages/domain/src/errors.js'
import type { WorkspaceSummary } from '../../packages/domain/src/workspaces.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/** Credential reference the probe stores and clears on the throwaway home. */
const PROBE_REFERENCE = 'DSH_VSC_LIVE_PROBE_KEY'
/** Agent preset id the probe authors and deletes on the throwaway home. */
const PROBE_PRESET_ID = 'dsh-vsc-live-probe'
/** Session title the probe asks the host to accept. */
const PROBE_TITLE = 'DSH VSC live write probe'
/** The host resolves these from the session's own defaults when they are blank. */
const blankSessionConfiguration: AgentConfiguration = {
  preset: '',
  toolMode: 'native',
  permissionPreset: '',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

/**
 * Live write-path evidence for the pinned runtime build. The managed host is
 * started with `$DSH_HOME` pointed at a throwaway directory, so every durable
 * write this spec commits lands there: the user's real profile is neither read
 * nor changed. No prompt is sent and no model turn is started.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'   # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/writes.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never touched.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH write paths on an isolated home', () => {
  it(
    'commits, observes and reverts real writes without touching the user profile',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-home-'))
      process.env.DSH_HOME = home
      const steps: string[] = []
      const skipped: string[] = []
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        const unsubscribe = backend.events.subscribe(() => undefined)
        try {
          steps.push('isolated DSH home in place')
          await credentialRoundTrip(backend, home, steps)
          await settingsRoundTrip(backend, steps, skipped)
          await presetRoundTrip(backend, steps, skipped)
          await workspaceRoundTrip(backend, runtime.snapshot.workspace, steps)
          await orderingRoundTrip(backend, steps)
        } finally {
          unsubscribe()
        }
      } finally {
        let released: boolean | undefined
        if (runtime !== undefined) {
          await runtime.stop()
          released = !(await canConnect(runtime.snapshot.port))
          steps.push(`managed stop port ${runtime.snapshot.port} released=${String(released)}`)
        }
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        await rm(home, { recursive: true, force: true })
        for (const step of steps) console.log(`[dsh-live-writes] ${step}`)
        for (const line of skipped) console.log(`[dsh-live-writes] skipped ${line}`)
        if (released !== undefined)
          expect(released, `loopback port ${runtime?.snapshot.port ?? 0} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/**
 * The credential store is a plain document under the throwaway home, so the
 * probe can prove the write landed there instead of the real profile. The
 * receipt for both writes carries no value on this host; an empty projection is
 * exactly what these steps pin.
 */
async function credentialRoundTrip(backend: DshBackend, home: string, steps: string[]): Promise<void> {
  const storePath = path.join(home, '.credentials.yaml')
  const before = await backend.credentials.describeReference(PROBE_REFERENCE)
  expect(before.configured, `the throwaway home must not preconfigure ${PROBE_REFERENCE}`).toBe(false)
  steps.push(
    `credentials.describe configured=${String(before.configured)} writable=${String(before.writable)}`,
  )

  await backend.credentials.setReference(PROBE_REFERENCE, 'sk-dsh-vsc-live-probe')
  const stored = await backend.credentials.describeReference(PROBE_REFERENCE)
  expect(stored.configured, 'credentials.set must leave the reference configured').toBe(true)
  const document = await readFile(storePath, 'utf8').catch(() => undefined)
  expect(document, 'the stored reference must land in the throwaway home').toContain(PROBE_REFERENCE)
  steps.push('credentials.set accepted and durable in the throwaway home')

  await backend.credentials.unsetReference(PROBE_REFERENCE)
  const cleared = await backend.credentials.describeReference(PROBE_REFERENCE)
  expect(cleared.configured, 'credentials.unset must clear the reference again').toBe(false)
  const after = await readFile(storePath, 'utf8').catch(() => undefined)
  expect(after ?? '', 'credentials.unset must remove the stored reference').not.toContain(PROBE_REFERENCE)
  steps.push('credentials.unset accepted and durable in the throwaway home')
}

/**
 * Write one real field the host itself advertises and restore it. The field is
 * picked from the live schema — never from a list this repository guesses — and
 * a field with no user override is reverted through `settings.unset`, which pins
 * both the `set` and the `unset` mutation ops end to end.
 *
 * A settings field can carry cross-field constraints, so a candidate the host
 * refuses (`settings/rejected`) is evidence about the profile, not a client
 * defect: the probe walks to the next candidate and only fails when the flip it
 * committed does not read back.
 */
async function settingsRoundTrip(backend: DshBackend, steps: string[], skipped: string[]): Promise<void> {
  const schema = await backend.settings.schema()
  const candidates = booleanSettingCandidates(schema, await backend.settings.read())
  if (candidates.length === 0) {
    skipped.push('settings write skipped: the live schema exposes no plain boolean field')
    return
  }
  const refusals: string[] = []
  for (const { path: fieldPath, namespace, current } of candidates) {
    try {
      await backend.settings.update(fieldPath, !current)
    } catch (error) {
      const rpcCode = (error as Partial<AppError>).context?.rpcCode
      if (typeof rpcCode !== 'string' || !rpcCode.startsWith('settings/')) throw error
      refusals.push(`${fieldPath} ${rpcCode}`)
      continue
    }
    const flipped = valuesAfter(await backend.settings.read(), namespace, fieldPath)
    expect(flipped, `${fieldPath} must read back the value the write committed`).toBe(!current)
    steps.push(`settings.update ${fieldPath} ${String(current)}->${String(!current)} observed`)

    const overridden = schema.namespaces
      .find((entry) => entry.ns === namespace)
      ?.userFields.includes(fieldPath.slice(namespace.length + 1))
    const revert = overridden === true ? 'update' : 'unset'
    if (overridden === true) await backend.settings.update(fieldPath, current)
    else await backend.settings.unset(fieldPath)
    const restored = valuesAfter(await backend.settings.read(), namespace, fieldPath)
    expect(restored, `${fieldPath} must be restored by the ${revert}`).toBe(current)
    steps.push(`settings.${revert} ${fieldPath} restored`)
    return
  }
  skipped.push(
    `settings write skipped: the host refused every boolean candidate (${refusals.slice(0, 3).join('; ')})`,
  )
}

/**
 * Boolean fields the host advertises, most-likely-acceptable first: a live
 * namespace, and disabling (a field that is currently on) before enabling.
 * Disabling avoids the "requires at least one …" class of cross-field refusal.
 */
function booleanSettingCandidates(
  schema: DshSettingsSchema,
  values: Readonly<Record<string, unknown>>,
): readonly { readonly path: string; readonly namespace: string; readonly current: boolean }[] {
  const live = new Set(schema.namespaces.filter((entry) => entry.applies === 'live').map((entry) => entry.ns))
  const candidates: { path: string; namespace: string; current: boolean }[] = []
  for (const field of schema.fields) {
    if (field.type !== 'boolean' || field.restartRequired) continue
    const namespace = namespaceOf(field.path)
    const current = valuesAfter(values, namespace, field.path)
    if (typeof current === 'boolean') candidates.push({ path: field.path, namespace, current })
  }
  return [
    ...candidates.filter((entry) => entry.current && live.has(entry.namespace)),
    ...candidates.filter((entry) => entry.current && !live.has(entry.namespace)),
    ...candidates.filter((entry) => !entry.current && live.has(entry.namespace)),
    ...candidates.filter((entry) => !entry.current && !live.has(entry.namespace)),
  ]
}

/** The namespace segment of a schema field path. */
function namespaceOf(fieldPath: string): string {
  const separator = fieldPath.indexOf('.')
  return separator === -1 ? fieldPath : fieldPath.slice(0, separator)
}

function valuesAfter(
  values: Readonly<Record<string, unknown>>,
  namespace: string,
  fieldPath: string,
): unknown {
  const rest = fieldPath.slice(namespace.length + 1).split('.')
  let current: unknown = values[namespace]
  for (const part of rest) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Author a preset beside the shipped ones and delete it again. `copy` and
 * `deletePreset` both resolve void on this host, so the receipts these steps
 * assert are the projected ones the client contract requires.
 */
async function presetRoundTrip(backend: DshBackend, steps: string[], skipped: string[]): Promise<void> {
  const copy = backend.presets.copy
  const remove = backend.presets.remove
  if (copy === undefined || remove === undefined) {
    skipped.push('preset authoring skipped: the adapter exposes no copier or deleter')
    return
  }
  const roster = await backend.presets.list()
  if (!roster.authorable) {
    skipped.push('preset authoring skipped: the deployment exposes no authorable preset root')
    return
  }
  const source = roster.presets.find((preset) => preset.id.trim() !== '')
  if (source === undefined) {
    skipped.push('preset authoring skipped: the roster ships no preset to copy from')
    return
  }
  expect(
    roster.presets.some((preset) => preset.id === PROBE_PRESET_ID),
    `the throwaway home must not already carry ${PROBE_PRESET_ID}`,
  ).toBe(false)

  const copied = await copy.call(backend.presets, source.id, PROBE_PRESET_ID, 'DSH VSC live write probe')
  expect(copied, 'agentPreset.copy must identify the new preset').toBe(PROBE_PRESET_ID)
  const authored = await backend.presets.list()
  expect(
    authored.presets.some((preset) => preset.id === PROBE_PRESET_ID),
    'the copy must appear in the roster',
  ).toBe(true)

  const read = backend.presets.read
  if (read !== undefined) {
    const document = await read.call(backend.presets, PROBE_PRESET_ID)
    expect(document.id, 'agentPreset.read must echo the copied id').toBe(PROBE_PRESET_ID)
    expect(document.trust, 'an authored preset must be stored as a user preset').toBe('user')
    steps.push(`presets.copy ${source.id} -> ${copied} (${document.content.length} char(s))`)
  }

  await remove.call(backend.presets, PROBE_PRESET_ID)
  const afterRemove = await backend.presets.list()
  expect(
    afterRemove.presets.some((preset) => preset.id === PROBE_PRESET_ID),
    'agentPreset.remove must delete the authored preset',
  ).toBe(false)
  steps.push(`presets.remove deleted ${PROBE_PRESET_ID}`)
}

/**
 * The switcher renders the durable registry order, which the client reads back
 * through the synthesized `workspace/list`. Every move is asserted through the
 * order the next list call reports — in both directions — so a write the host
 * accepts but never applies fails here instead of leaving the sidebar in an
 * order the user did not ask for.
 */
async function orderingRoundTrip(backend: DshBackend, steps: string[]): Promise<void> {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-order-a-'))
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-order-b-'))
  const first = await backend.workspaces.create({ name: 'DSH VSC live order A', path: firstDirectory })
  const second = await backend.workspaces.create({ name: 'DSH VSC live order B', path: secondDirectory })
  try {
    await backend.workspaces.insertBefore(second.id, first.id)
    const moved = await backend.workspaces.list()
    expect(
      rowIndex(moved, second.id),
      'workspace.insertBefore must place the moved workspace before its anchor',
    ).toBeLessThan(rowIndex(moved, first.id))

    await backend.workspaces.insertBefore(first.id, second.id)
    const restored = await backend.workspaces.list()
    expect(
      rowIndex(restored, first.id),
      'workspace.insertBefore must move the workspace back before its anchor',
    ).toBeLessThan(rowIndex(restored, second.id))
    steps.push('workspaces.insertBefore observed in both directions')

    const older = await backend.sessions.create({
      workspaceId: first.id,
      configuration: blankSessionConfiguration,
    })
    const newer = await backend.sessions.create({
      workspaceId: first.id,
      configuration: blankSessionConfiguration,
    })
    await backend.workspaces.insertSessionBefore(first.id, newer.id, older.id)
    const newerFirst = sessionOrder(await backend.workspaces.list(), first.id)
    expect(
      newerFirst.indexOf(newer.id),
      'workspace.insertSessionBefore must place the moved session before its anchor',
    ).toBeLessThan(newerFirst.indexOf(older.id))

    await backend.workspaces.insertSessionBefore(first.id, older.id, newer.id)
    const olderFirst = sessionOrder(await backend.workspaces.list(), first.id)
    expect(
      olderFirst.indexOf(older.id),
      'workspace.insertSessionBefore must move the session back before its anchor',
    ).toBeLessThan(olderFirst.indexOf(newer.id))
    steps.push('workspaces.insertSessionBefore observed in both directions')

    // Keep the throwaway registry consistent for the steps that follow.
    await backend.sessions.setArchived(newer.id, true)
    await backend.sessions.setArchived(older.id, true)
  } finally {
    await backend.workspaces.remove(second.id)
    await backend.workspaces.remove(first.id)
    await rm(secondDirectory, { recursive: true, force: true })
    await rm(firstDirectory, { recursive: true, force: true })
  }
}

function rowIndex(rows: readonly WorkspaceSummary[], workspaceId: string): number {
  const index = rows.findIndex((row) => row.id === workspaceId)
  expect(index, `the live workspace list must contain ${workspaceId}`).toBeGreaterThanOrEqual(0)
  return index
}

function sessionOrder(rows: readonly WorkspaceSummary[], workspaceId: string): readonly string[] {
  const row = rows.find((entry) => entry.id === workspaceId)
  expect(
    row?.sessionIds,
    `the workspace row for ${workspaceId} must carry its session membership`,
  ).toBeDefined()
  return row?.sessionIds ?? []
}

/**
 * Register a workspace, create a session inside it, rename, archive and delete
 * again — none of which starts a model turn.
 */
async function workspaceRoundTrip(backend: DshBackend, directory: string, steps: string[]): Promise<void> {
  const workspace = await backend.workspaces.create({ name: 'DSH VSC live write probe', path: directory })
  steps.push(`workspaces.create created id=${workspace.id}`)
  await backend.workspaces.insertBefore(workspace.id)
  steps.push('workspaces.insertBefore accepted')

  const created = await backend.sessions.create({
    workspaceId: workspace.id,
    configuration: blankSessionConfiguration,
  })
  steps.push(`sessions.create status=${created.status}`)

  await backend.workspaces.insertSessionBefore(workspace.id, created.id)
  steps.push('workspaces.insertSessionBefore accepted')

  const accepted = await backend.sessions.rename(created.id, PROBE_TITLE)
  expect(accepted, 'session.rename must report the title the host accepted').toBe(PROBE_TITLE)
  const detail = await backend.sessions.get(created.id)
  expect(detail.title, 'the accepted title must survive an authoritative session read').toBe(PROBE_TITLE)
  steps.push(`sessions.rename accepted ${JSON.stringify(accepted)}`)

  // The same Session read through the two paths the client uses: the list row
  // the switcher shows, and the detail a freshly created Session opens with.
  const rows = (await backend.sessions.list()).items.filter((item) => item.id === created.id)
  const history = await backend.sessions.history(created.id)
  steps.push(
    `sessions.list row blank=${String(rows[0]?.blank)} status=${rows[0]?.status} detail blank=${String(detail.blank)} status=${detail.status}`,
  )
  steps.push(
    `sessions.history ${history.events.length} event(s) [${[...new Set(history.events.map((entry) => entry.event.type))].join(',')}]`,
  )

  await backend.sessions.setArchived(created.id, true)
  const archived = await backend.workspaces.listArchivedSessionIds()
  expect(archived, 'workspace.archiveSession must echo the archived session').toContain(created.id)
  steps.push('sessions.setArchived echoed by workspaces.listArchivedSessionIds')

  await backend.workspaces.remove(workspace.id)
  const remaining = await backend.workspaces.list()
  expect(
    remaining.some((item) => item.id === workspace.id),
    'workspace.delete must remove the registration',
  ).toBe(false)
  steps.push('workspaces.remove deleted the registration')
}
