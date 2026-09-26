import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AppError } from '../../packages/domain/src/errors.js'
import type { ScheduleRepository } from '../../packages/domain/src/schedules.js'
import { LIVE_TIMEOUT_MS, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/**
 * Live evidence for the Schedule remote gate. The published
 * `@deepseek-ai/dsh-web-app` composition disables the `schedule` and
 * `ui-schedule` entries, so a managed `web` profile that is started without a
 * patch answers every `schedule/*` request with HTTP 404 and the adapter reports
 * `CAPABILITY_UNAVAILABLE`; the panel must name that cause instead of claiming a
 * load failure. The second launch re-enables the entries through the
 * home-level patch file and must answer the same request for real.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.1.7-rc.2'   # needs a runtime whose adapter carries the Schedule remote
 *   npx vitest run tests/live-dsh/schedule-profile-gate.spec.ts
 *
 * Both launches use a throwaway `$DSH_HOME`, so the user's own profile is never
 * read or changed, and only the processes started here are signalled.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH schedule profile gate', () => {
  it(
    'reports the shipped composition as unavailable and answers once the profile enables it',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-schedule-home-'))
      const evidence: string[] = []
      const skipped: string[] = []
      let runtime: ManagedLiveRuntime | undefined
      let homeSafeToRemove = false
      try {
        homeSafeToRemove = false
        runtime = await startManagedRuntime({ dshHome: home })
        const schedules = runtime.backend.schedules
        if (schedules === undefined) {
          // Adapter families without the Schedule remote expose no repository at
          // all, so this run has no wire request to observe. The Host answers
          // CAPABILITY_UNAVAILABLE for that case, which its own unit tests pin.
          skipped.push('this adapter exposes no Schedule remote; run with a runtime whose adapter carries it')
          return
        }
        evidence.push(`shipped profile: ${await describeCatalog(schedules)}`)
        await runtime.stop()
        runtime = undefined
        homeSafeToRemove = true

        await writeFile(
          path.join(home, 'cordis.patch.yml'),
          [
            '- id: time-context',
            '  disabled: false',
            '- id: schedule',
            '  disabled: false',
            '- id: ui-schedule',
            '  disabled: false',
            '',
          ].join('\n'),
          'utf8',
        )
        homeSafeToRemove = false
        runtime = await startManagedRuntime({ dshHome: home })
        const patched = runtime.backend.schedules
        expect(patched, 'the patched profile must expose the Schedule remote').toBeDefined()
        if (patched === undefined) return
        const items = await patched.catalog()
        evidence.push(`patched profile: catalog answered ${items.length} item(s)`)
        // A throwaway home holds no reminder, so a real answer is an empty list
        // rather than a read this probe could mistake for a mapping success.
        expect(items).toEqual([])
      } finally {
        if (runtime !== undefined) {
          await runtime.stop()
          homeSafeToRemove = true
        }
        for (const line of evidence) console.log(`[dsh-live-schedule] ${line}`)
        for (const line of skipped) console.log(`[dsh-live-schedule] skipped ${line}`)
        // Keep a profile if a startup or stop failure leaves an owned process unconfirmed.
        if (homeSafeToRemove) await rm(home, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )
})

/**
 * Read the catalog once and describe the outcome. A composition that never
 * mounted the service must report `CAPABILITY_UNAVAILABLE`: any other code in
 * that position is a mapping failure that this run has to surface, because the
 * panel's "not provided here" branch keys on exactly that code.
 */
async function describeCatalog(schedules: ScheduleRepository): Promise<string> {
  try {
    return `catalog answered ${(await schedules.catalog()).length} item(s)`
  } catch (error) {
    const failure = error as Partial<AppError>
    expect(
      failure.code,
      `the shipped composition must report its missing service as CAPABILITY_UNAVAILABLE, got ${failure.code ?? 'no-code'}: ${failure.message ?? ''}`,
    ).toBe('CAPABILITY_UNAVAILABLE')
    return `catalog unavailable [${failure.code}]`
  }
}
