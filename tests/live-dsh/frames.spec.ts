import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DshBackend } from '../../packages/domain/src/backend.js'
import type { AppError } from '../../packages/domain/src/errors.js'
import type { AgentConfiguration } from '../../packages/domain/src/models.js'
import type { SessionDetail } from '../../packages/domain/src/sessions.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/** Identities that cannot exist on a throwaway home, used to reach the wire without committing a write. */
const ABSENT_SESSION = 'dsh-vsc-live-absent-session'
const ABSENT_ATTACHMENT = 'dsh-vsc-live-absent-attachment'
const ABSENT_MESSAGE = 'dsh-vsc-live-absent-message'

/** Command-line token no command directory can own; the host resolves it itself. */
const OUT_OF_DIRECTORY_LINE = 'dsh-live-frame-probe'

/**
 * A 1x1 PNG as a data URI. An attachment is the part of the prompt frame that a
 * text-only probe never touches: the Gateway decodes `content` with a strict
 * descriptor, so a wrong image member is rejected as a decode failure before the
 * request reaches the Session Controller.
 */
const PROBE_IMAGE = {
  uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  name: 'probe.png',
  mimeType: 'image/png',
} as const

/**
 * The Gateway answers `gateway/arguments-invalid` and `gateway/input-invalid`
 * when a call's shape does not match the invocation descriptor, and the alpha
 * vocabulary normalizes those onto exactly these three business codes. Every
 * refusal probed here must stay out of this set: a code from it means the frame
 * — not the request — was wrong.
 */
const DECODE_FAILURE_CODES = new Set(['bad-request', 'internal', 'unknown-command'])

/**
 * Live frame evidence for write verbs whose success path cannot run without a
 * model turn or a delegated child: `session.prompt`, `session.updateQueue` and
 * `subagents.prompt` only exist inside a running turn. Those verbs are reached
 * with a refusal-shaped request instead — an identity the host must reject — so
 * the call still crosses the real transport, the real descriptor validation and
 * the real error mapping. A frame the host cannot decode is the only way such a
 * probe fails; a refusal is the expected, successful outcome.
 *
 * The managed host runs against a throwaway `$DSH_HOME`, so the one durable
 * write this spec commits (a workspace registration and a blank Session) lands
 * there and the user's profile is neither read nor changed. No prompt is sent
 * to a live session and no model turn is started.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'   # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/frames.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never touched.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live write-verb frames on an isolated home', () => {
  it(
    'reaches the real host for verbs whose success path needs a running turn',
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
          await absentSessionFrames(backend, steps)
          const { workspaceId, session } = await publishProbeSession(
            backend,
            runtime.snapshot.workspace,
            steps,
          )
          await absentIdentityFrames(backend, session, steps)
          await commandAttachmentFrame(backend, session, steps)
          await presetSelectionFrame(backend, session, steps, skipped)
          await modelSelectionFrame(backend, session, steps, skipped)
          await forkFrame(backend, session, steps)
          await cancelFrame(backend, session, steps)
          await archiveForkedSession(backend, session, workspaceId, steps)
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
        for (const step of steps) console.log(`[dsh-live-frames] ${step}`)
        for (const line of skipped) console.log(`[dsh-live-frames] skipped ${line}`)
        if (released !== undefined)
          expect(released, `loopback port ${runtime?.snapshot.port ?? 0} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

interface FrameOutcome<T> {
  readonly accepted: boolean
  readonly value?: T
  /** The DSH business code carried by the refusal, empty when the call was accepted. */
  readonly code: string
  /** The client-side classification of the refusal, so a probe can pin how it reaches the UI. */
  readonly appCode: string
}

/**
 * Run one write against the real host and classify its outcome. The only
 * failure this helper reports is a frame failure: a `PROTOCOL_ERROR` means the
 * client could not read the answer at all, and a decode-failure code means the
 * Gateway rejected the call's shape before the request was ever handled.
 */
async function frame<T>(label: string, run: () => Promise<T>): Promise<FrameOutcome<T>> {
  try {
    return { accepted: true, value: await run(), code: '', appCode: '' }
  } catch (error) {
    const appError = error as Partial<AppError>
    const code = typeof appError.context?.rpcCode === 'string' ? appError.context.rpcCode : ''
    expect(
      appError.code,
      `${label} must not surface as a protocol error (rpcCode=${code === '' ? 'unset' : code})`,
    ).not.toBe('PROTOCOL_ERROR')
    expect(code, `${label} must answer with a host business code`).not.toBe('')
    expect(
      DECODE_FAILURE_CODES.has(code),
      `${label} answered a gateway decode code (${code}), which means the call shape is wrong`,
    ).toBe(false)
    return { accepted: false, code, appCode: typeof appError.code === 'string' ? appError.code : '' }
  }
}

/**
 * The three Session verbs a fresh client issues only inside a running turn.
 * Each one is addressed at a Session that cannot exist, so the host refuses in
 * its own vocabulary instead of starting anything.
 */
async function absentSessionFrames(backend: DshBackend, steps: string[]): Promise<void> {
  const prompt = await frame('session.prompt on an absent session', () =>
    backend.sessions.sendPrompt({ sessionId: ABSENT_SESSION, text: 'frame probe', attachments: [] }),
  )
  expect(prompt.accepted, 'an absent session cannot accept a prompt').toBe(false)
  expect(prompt.code, 'the prompt frame must reach the session controller').toBe('session-not-found')
  steps.push(`sessions.sendPrompt refused ${prompt.code}`)

  const cancel = await frame('session.cancel on an absent session', () =>
    backend.sessions.cancel(ABSENT_SESSION),
  )
  expect(cancel.accepted, 'an absent session cannot be cancelled').toBe(false)
  expect(cancel.code, 'the cancel frame must reach the session controller').toBe('session-not-found')
  steps.push(`sessions.cancel refused ${cancel.code}`)

  const fork = await frame('session.fork on an absent session', () => backend.sessions.fork(ABSENT_SESSION))
  expect(fork.accepted, 'an absent session cannot be forked').toBe(false)
  expect(fork.code, 'the fork frame must reach the session controller').toBe('session-not-found')
  steps.push(`sessions.fork refused ${fork.code}`)

  // The composer sends an attached image inside the same content array as its
  // text. The Session Controller refuses the absent session, which proves the
  // image member decoded; a decode code here would mean the composer's own
  // attachment shape never reaches the host.
  const attached = await frame('session.prompt with an image on an absent session', () =>
    backend.sessions.sendPrompt({
      sessionId: ABSENT_SESSION,
      text: 'frame probe',
      attachments: [PROBE_IMAGE],
    }),
  )
  expect(attached.accepted, 'an absent session cannot accept an image prompt').toBe(false)
  expect(attached.code, 'the image prompt frame must reach the session controller').toBe('session-not-found')
  steps.push(`sessions.sendPrompt with an image refused ${attached.code}`)
}

/**
 * The composer's other attachment path: a slash command carrying an image. The
 * host declares its attachment parameter as a strict union, so the probe asks
 * for a line its directory cannot own — the answer must be the "not a command"
 * absence rather than a refusal to decode what was sent.
 */
async function commandAttachmentFrame(
  backend: DshBackend,
  session: SessionDetail,
  steps: string[],
): Promise<void> {
  const directory = await backend.commands.list(session.id)
  const names = new Set(directory.map((command) => command.name.trim().toLocaleLowerCase()))
  let line = OUT_OF_DIRECTORY_LINE
  for (let index = 0; names.has(line); index += 1) line = `${OUT_OF_DIRECTORY_LINE}-${index}`
  const executed = await frame('commands.execute with an image', () =>
    backend.commands.execute(session.id, `/${line}`, [PROBE_IMAGE]),
  )
  expect(executed.accepted, 'an out-of-directory line must not be refused as a decode failure').toBe(true)
  expect(
    executed.value,
    `${line} is not in the command directory, so the host must answer the absence instead of a result`,
  ).toEqual({ kind: 'unknown' })
  steps.push(`commands.execute carried an image for /${line} and answered unknown`)
}

/** Register a workspace and publish one blank Session to probe against. */
async function publishProbeSession(
  backend: DshBackend,
  directory: string,
  steps: string[],
): Promise<{ readonly workspaceId: string; readonly session: SessionDetail }> {
  const workspace = await backend.workspaces.create({ name: 'DSH VSC live frame probe', path: directory })
  const session = await backend.sessions.create({
    workspaceId: workspace.id,
    configuration: {
      preset: '',
      toolMode: 'native',
      permissionPreset: '',
      planMode: false,
      model: { providerId: '', modelId: '' },
    },
  })
  steps.push(
    `probe session published workspace=${workspace.id} session=${session.id} status=${session.status}`,
  )
  return { workspaceId: workspace.id, session }
}

/** Reads addressed at published identities with an absent member of the pair. */
async function absentIdentityFrames(
  backend: DshBackend,
  session: SessionDetail,
  steps: string[],
): Promise<void> {
  const attachment = await frame('session.attachment on an absent attachment', () =>
    backend.sessions.readAttachment(session.id, ABSENT_ATTACHMENT),
  )
  expect(attachment.accepted, 'an absent attachment cannot be read').toBe(false)
  steps.push(`sessions.readAttachment refused ${attachment.code}`)

  // The feedback sidecar answers its own business union: a message that is not
  // in the session log is `target-not-found`, and the Webview hides the whole
  // feedback surface when it is told the capability is unavailable. Reporting
  // this refusal as CAPABILITY_UNAVAILABLE would disable a working feature for
  // the rest of the session, so the probe pins both the host code and the
  // classification it reaches the UI with.
  const feedback = await frame('messageFeedback/put for an absent message', () =>
    backend.feedback.put(session.id, ABSENT_MESSAGE, 'positive'),
  )
  expect(feedback.accepted, 'an absent message cannot carry feedback').toBe(false)
  expect(feedback.code, 'the put frame must reach the feedback sidecar').toBe('target-not-found')
  expect(feedback.appCode, 'a stale feedback target must not be reported as an absent capability').not.toBe(
    'CAPABILITY_UNAVAILABLE',
  )
  steps.push(`feedback.put refused ${feedback.code} as ${feedback.appCode}`)
}

/**
 * `agentPresets/select` is the verb behind the preset picker. Selecting a
 * shipped preset for a blank Session is an ordinary user action; a refusal is
 * still frame evidence.
 */
async function presetSelectionFrame(
  backend: DshBackend,
  session: SessionDetail,
  steps: string[],
  skipped: string[],
): Promise<void> {
  const roster = await backend.presets.list()
  const preset = roster.presets.find((entry) => entry.id.trim() !== '' && entry.broken === undefined)
  if (preset === undefined) {
    skipped.push('agentPreset.select skipped: the roster ships no usable preset')
    return
  }
  const selected = await frame('agentPreset.select', () => backend.presets.select(session.id, preset.id))
  if (selected.accepted) steps.push(`presets.select accepted ${preset.id}`)
  else steps.push(`presets.select refused ${selected.code}`)
}

/**
 * `session.selectModel` is the verb behind the model picker. It is only
 * reachable through `setConfiguration` on a published Session, and the probe
 * pins the whole path: the write, the authoritative read-back, and the fact
 * that no unrelated setting was mutated on the way.
 */
async function modelSelectionFrame(
  backend: DshBackend,
  session: SessionDetail,
  steps: string[],
  skipped: string[],
): Promise<void> {
  const catalog = await backend.models.listSessionModels(session.id)
  const current = session.configuration.model
  const candidate = catalog.models.find(
    (model) => model.providerId !== current.providerId || model.id !== current.modelId,
  )
  if (candidate === undefined) {
    skipped.push('session.selectModel skipped: the catalog exposes no second routable model')
    return
  }
  // `setConfiguration` refuses a blank permission preset before it sends
  // anything, and changing one would run a session command instead of the
  // model verb this probe is about.
  const permissionPreset = session.configuration.permissionPreset.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(permissionPreset)) {
    skipped.push(
      `session.selectModel skipped: the blank session reports no usable permission preset (${JSON.stringify(permissionPreset)})`,
    )
    return
  }
  const configuration: AgentConfiguration = {
    preset: '',
    toolMode: 'native',
    permissionPreset,
    planMode: session.configuration.planMode,
    model: { providerId: candidate.providerId, modelId: candidate.id },
  }
  const selected = await frame('session.selectModel', () =>
    backend.sessions.setConfiguration(session.id, configuration),
  )
  if (!selected.accepted) {
    steps.push(`session.selectModel refused ${selected.code}`)
    return
  }
  const detail = await backend.sessions.get(session.id)
  expect(
    [detail.configuration.model.providerId, detail.configuration.model.modelId],
    'the selected model must survive an authoritative session read',
  ).toEqual([candidate.providerId, candidate.id])
  steps.push(`session.selectModel applied ${candidate.providerId}/${candidate.id} and read back`)
}

/** `session.fork` on a published Session: a distinct Session, or a business refusal. */
async function forkFrame(backend: DshBackend, session: SessionDetail, steps: string[]): Promise<void> {
  const forked = await frame('session.fork on a published session', () => backend.sessions.fork(session.id))
  if (!forked.accepted) {
    steps.push(`sessions.fork refused ${forked.code}`)
    return
  }
  const published = forked.value as SessionDetail
  expect(published.id, 'session.fork must publish a distinct session').not.toBe(session.id)
  steps.push(`sessions.fork published ${published.id}`)
}

/** `session.cancel` while the Session is idle: accepted, or a business refusal. */
async function cancelFrame(backend: DshBackend, session: SessionDetail, steps: string[]): Promise<void> {
  const cancelled = await frame('session.cancel on an idle session', () =>
    backend.sessions.cancel(session.id),
  )
  if (cancelled.accepted) steps.push('sessions.cancel accepted on an idle session')
  else steps.push(`sessions.cancel refused ${cancelled.code}`)

  const detail = await backend.sessions.get(session.id)
  expect(detail.id, 'an idle session must survive a cancel request').toBe(session.id)
}

/** Leave the registry the way the switcher does, so the throwaway home stays consistent. */
async function archiveForkedSession(
  backend: DshBackend,
  session: SessionDetail,
  workspaceId: string,
  steps: string[],
): Promise<void> {
  await backend.sessions.setArchived(session.id, true)
  const archived = await backend.workspaces.listArchivedSessionIds()
  expect(archived, 'workspace.archiveSession must echo the probed session').toContain(session.id)
  await backend.workspaces.remove(workspaceId)
  const remaining = await backend.workspaces.list()
  expect(
    remaining.some((item) => item.id === workspaceId),
    'workspace.delete must remove the probe registration',
  ).toBe(false)
  steps.push('probe registration removed from the throwaway registry')
}
