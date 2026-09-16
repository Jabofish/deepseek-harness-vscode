import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SessionRepository } from '../../packages/domain/src/backend.js'
import type { MessageImageReference } from '../../packages/domain/src/events.js'
import type { AgentConfiguration } from '../../packages/domain/src/models.js'
import type { SessionHistoryEvent } from '../../packages/domain/src/sessions.js'
import { LIVE_TIMEOUT_MS, canConnect, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/**
 * A 2x1 PNG: a 1x1 probe could not tell a swapped width from a swapped height,
 * and the Webview sizes a single-image thumbnail by the reference's aspect
 * ratio (`MessageImages.imageRatioStyle`), so the two numbers must be right.
 */
const PROBE_IMAGE = {
  uri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=',
  name: 'probe.png',
  mimeType: 'image/png',
} as const

const PROBE_BYTES = Buffer.from(PROBE_IMAGE.uri.slice(PROBE_IMAGE.uri.indexOf(',') + 1), 'base64')
const DURABLE_ROW_TIMEOUT_MS = 20_000
const POLL_INTERVAL_MS = 500
const HISTORY_PAGES = 4

const BLANK_CONFIGURATION: AgentConfiguration = {
  preset: '',
  toolMode: 'native',
  permissionPreset: '',
  planMode: false,
  model: { providerId: '', modelId: '' },
}

/**
 * The attachment round trip: composer image in, durable reference out, bytes
 * back. Every other live spec stops at the frame, because a durable image
 * reference only exists inside a submitted user message — there is no way to
 * ask the host to store one. This spec therefore submits exactly one prompt
 * carrying the probe PNG on a throwaway `$DSH_HOME`, which carries no
 * credentials: the provider call it triggers is expected to fail, and the probe
 * asserts only the durable user row and the read-back, never the turn's
 * outcome. The user's profile is neither read nor changed.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.6-alpha.1'   # optional; defaults to the pinned runtime
 *   npx vitest run tests/live-dsh/attachment.spec.ts
 *
 * Only the process started here is signalled; an external DSH is never touched.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live attachment round trip on an isolated home', () => {
  it(
    'publishes a durable image reference and reads the same bytes back',
    async () => {
      const previousHome = process.env.DSH_HOME
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-home-'))
      process.env.DSH_HOME = home
      const steps: string[] = []
      let runtime: ManagedLiveRuntime | undefined
      try {
        runtime = await startManagedRuntime()
        const { backend } = runtime
        const unsubscribe = backend.events.subscribe(() => undefined)
        try {
          steps.push('isolated DSH home in place')
          const workspace = await backend.workspaces.create({
            name: 'DSH VSC live attachment probe',
            path: runtime.snapshot.workspace,
          })
          const session = await backend.sessions.create({
            workspaceId: workspace.id,
            configuration: BLANK_CONFIGURATION,
          })
          steps.push(`probe session published session=${session.id} status=${session.status}`)

          await backend.sessions.sendPrompt({
            sessionId: session.id,
            text: 'live attachment round trip',
            attachments: [PROBE_IMAGE],
          })
          steps.push(`session.prompt accepted with ${PROBE_BYTES.length} image bytes`)

          const reference = await waitForDurableImage(backend.sessions, session.id, steps)
          expect(reference.mediaType, 'the durable reference must keep the probed media type').toBe(
            PROBE_IMAGE.mimeType,
          )
          expect(reference.bytes, 'the durable reference must count the bytes that were sent').toBe(
            PROBE_BYTES.length,
          )
          expect(
            [reference.width, reference.height],
            'the durable reference must describe the probe geometry in order',
          ).toEqual([2, 1])

          const attachment = await backend.sessions.readAttachment(session.id, reference.attachmentId)
          const bytes = Buffer.from(attachment.uri.slice(attachment.uri.indexOf(',') + 1), 'base64')
          expect(attachment.mimeType, 'the read must report the probe media type').toBe(PROBE_IMAGE.mimeType)
          expect(bytes.length, 'the read must return the bytes the reference counted').toBe(reference.bytes)
          expect(bytes.equals(PROBE_BYTES), 'the read must return the image that was sent').toBe(true)
          expect(pngDimension(bytes), 'the read bytes must still be the probe PNG').toEqual({
            width: 2,
            height: 1,
          })
          steps.push(
            `sessions.readAttachment returned ${attachment.mimeType} bytes=${bytes.length} name=${attachment.name === '' ? 'none' : 'present'}`,
          )
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
        for (const step of steps) console.log(`[dsh-live-attachment] ${step}`)
        if (released !== undefined)
          expect(released, `loopback port ${runtime?.snapshot.port ?? 0} must be released`).toBe(true)
      }
    },
    LIVE_TIMEOUT_MS,
  )
})

/**
 * The host writes the user row before it can know the provider answer, so a
 * credential-less turn still publishes it. Polling rather than asserting once
 * keeps the acceptance race out of the probe: what matters is that the row
 * appears at all, not how fast.
 */
async function waitForDurableImage(
  sessions: SessionRepository,
  sessionId: string,
  steps: string[],
): Promise<MessageImageReference> {
  const deadline = Date.now() + DURABLE_ROW_TIMEOUT_MS
  for (let attempt = 1; ; attempt += 1) {
    const rows = await collectHistory(sessions, sessionId, HISTORY_PAGES)
    const images = rows.flatMap((row) => (row.event.type === 'message.user' ? (row.event.images ?? []) : []))
    const first = images[0]
    if (first !== undefined) {
      steps.push(`durable user image reference after ${attempt} poll(s) rows=${rows.length}`)
      return first
    }
    if (Date.now() >= deadline)
      expect.fail(
        `session.prompt published no durable image reference within ${DURABLE_ROW_TIMEOUT_MS}ms (rows=${rows.length} kinds=${[...new Set(rows.map((row) => row.event.type))].join(',')})`,
      )
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function collectHistory(
  sessions: SessionRepository,
  sessionId: string,
  maxPages: number,
): Promise<readonly SessionHistoryEvent[]> {
  const pages: SessionHistoryEvent[][] = []
  let beforeSequence: number | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const result = await sessions.history(sessionId, beforeSequence)
    if (result.events.length === 0) break
    pages.push([...result.events])
    if (!result.hasMore) break
    const oldest = result.beforeSequence ?? Math.min(...result.events.map((row) => row.sequence))
    if (!Number.isFinite(oldest) || (beforeSequence !== undefined && oldest >= beforeSequence)) break
    beforeSequence = oldest
  }
  return pages.reverse().flat()
}

function pngDimension(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47) return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
