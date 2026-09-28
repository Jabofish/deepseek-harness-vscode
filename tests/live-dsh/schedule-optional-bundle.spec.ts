import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AppError } from '../../packages/domain/src/errors.js'
import type { ScheduleRepository } from '../../packages/domain/src/schedules.js'
import { LIVE_TIMEOUT_MS, startManagedRuntime, type ManagedLiveRuntime } from './harness.js'

/**
 * Live evidence for the optional Schedule bundle on dsh-v0.2.0-rc.1
 * (4878cdabd87d4041bdaff61d04c966883b9fd07a). It discovers the bundle
 * from the live Plugin Manager catalog, checks
 * the disabled Remote response, toggles it through the pinned Remote, and
 * restarts only the harness-owned process if DSH reports `restart-required`.
 *
 *   $env:DSH_LIVE_SMOKE = '1'
 *   $env:DSH_LIVE_RUNTIME_VERSION = '0.2.0-rc.1'
 *   pnpm exec vitest run tests/live-dsh/schedule-optional-bundle.spec.ts
 *
 * Both launches use a throwaway `$DSH_HOME`, so the user's own profile is never
 * read or changed, and only the processes started here are signalled.
 */
describe.skipIf(process.env.DSH_LIVE_SMOKE !== '1')('live DSH optional Schedule bundle', () => {
  it(
    'reports the shipped composition as unavailable and answers once the profile enables it',
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-schedule-home-'))
      const evidence: string[] = []
      let runtime: ManagedLiveRuntime | undefined
      let disposeEvents: (() => void) | undefined
      let homeSafeToRemove = false
      try {
        runtime = await startManagedRuntime({ dshHome: home })
        const schedules = runtime.backend.schedules
        const bundles = runtime.backend.pluginBundles
        expect(schedules, 'the exact RC adapter must expose the Schedule Remote').toBeDefined()
        expect(bundles, 'the exact RC adapter must expose the Plugin Manager Remote').toBeDefined()
        if (schedules === undefined || bundles === undefined) return

        const catalog = await bundles.listBundles()
        const scheduleBundle = catalog.find(
          (bundle) =>
            bundle.optional && bundle.rows.some((row) => row.moduleName === '@deepseek-ai/dsh-schedule'),
        )
        expect(
          scheduleBundle,
          'the live Plugin Manager catalog must identify the optional Schedule bundle',
        ).toBeDefined()
        if (scheduleBundle === undefined) return
        expect(scheduleBundle.enabled).toBe(false)

        evidence.push(`default bundle state: ${scheduleBundle.name} disabled`)
        evidence.push(`default profile: ${await expectCatalogUnavailable(schedules)}`)

        let managerChangeEvents = 0
        disposeEvents = runtime.backend.events.subscribe((event) => {
          if (event.type === 'remote.event' && event.name === 'plugin-manager/changed')
            managerChangeEvents += 1
        })
        const enabled = await bundles.setBundleEnabled(scheduleBundle.name, true)
        expect(enabled).toMatchObject({ name: scheduleBundle.name, enabled: true, changed: true })
        expect(['applied', 'restart-required']).toContain(enabled.application)
        await waitForPluginManagerChange(() => managerChangeEvents > 0)
        evidence.push(`Plugin Manager change event observed (${enabled.application})`)

        if (enabled.application === 'restart-required') {
          disposeEvents()
          disposeEvents = undefined
          await runtime.stop()
          runtime = undefined
          homeSafeToRemove = true
          runtime = await startManagedRuntime({ dshHome: home })
          homeSafeToRemove = false
        }
        const enabledSchedules = runtime.backend.schedules
        expect(enabledSchedules).toBeDefined()
        if (enabledSchedules === undefined) return
        evidence.push(`enabled bundle: ${await expectCatalogAvailable(enabledSchedules)}`)

        const currentBundles = runtime.backend.pluginBundles
        expect(currentBundles).toBeDefined()
        if (currentBundles === undefined) return
        const disabled = await currentBundles.setBundleEnabled(scheduleBundle.name, false)
        expect(disabled).toMatchObject({ name: scheduleBundle.name, enabled: false, changed: true })
        expect(['applied', 'restart-required']).toContain(disabled.application)

        if (disabled.application === 'restart-required') {
          disposeEvents?.()
          disposeEvents = undefined
          await runtime.stop()
          runtime = undefined
          homeSafeToRemove = true
          runtime = await startManagedRuntime({ dshHome: home })
          homeSafeToRemove = false
        }
        const disabledSchedules = runtime.backend.schedules
        expect(disabledSchedules).toBeDefined()
        if (disabledSchedules === undefined) return
        evidence.push(`disabled bundle again: ${await expectCatalogUnavailable(disabledSchedules)}`)
      } finally {
        disposeEvents?.()
        if (runtime !== undefined) {
          await runtime.stop()
          homeSafeToRemove = true
        }
        for (const line of evidence) console.log(`[dsh-live-schedule-optional] ${line}`)
        // Keep a profile if a startup or stop failure leaves an owned process unconfirmed.
        if (homeSafeToRemove) await rm(home, { recursive: true, force: true })
      }
    },
    LIVE_TIMEOUT_MS * 2,
  )
})

async function expectCatalogUnavailable(schedules: ScheduleRepository): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      await schedules.catalog()
    } catch (error) {
      if ((error as Partial<AppError>).code !== 'CAPABILITY_UNAVAILABLE') throw error
      return 'catalog unavailable [CAPABILITY_UNAVAILABLE]'
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('the disabled Schedule bundle did not report CAPABILITY_UNAVAILABLE within 15s')
}

async function expectCatalogAvailable(schedules: ScheduleRepository): Promise<string> {
  const deadline = Date.now() + 15_000
  let lastUnavailable = false
  while (Date.now() < deadline) {
    try {
      const items = await schedules.catalog()
      // A throwaway home holds no reminder; an empty real response proves the
      // Remote mounted and the adapter decoded its result.
      expect(items).toEqual([])
      return `catalog answered ${items.length} item(s)`
    } catch (error) {
      if ((error as Partial<AppError>).code !== 'CAPABILITY_UNAVAILABLE') throw error
      lastUnavailable = true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(
    `the enabled Schedule bundle did not expose its Remote within 15s (${lastUnavailable ? 'still unavailable' : 'no response'})`,
  )
}

async function waitForPluginManagerChange(changed: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!changed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
  expect(changed(), 'the live bundle operation must publish plugin-manager/changed').toBe(true)
}
