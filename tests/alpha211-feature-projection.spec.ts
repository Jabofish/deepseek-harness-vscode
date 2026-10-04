import { describe, expect, it } from 'vitest'
import { ScheduleUseCases } from '../packages/application/src/use-cases/schedule-use-cases.js'
import { featureResponsePayloadSchema } from '../packages/webview-protocol/src/feature-schemas/feature-responses.js'

import { handleScheduleFeatureRequest } from '../apps/extension/src/schedules/schedule-feature-handler.js'
import { Alpha211ScheduleRepository } from '../packages/dsh-adapter/src/versions/alpha211/schedule-repository.js'
import { Alpha211PluginBundleRepository } from '../packages/dsh-adapter/src/versions/alpha211/plugin-manager-repository.js'
import { AlphaLoopbackApiClient } from '../packages/dsh-adapter/src/versions/alpha/transport.js'
import {
  installedBundle,
  scheduleUpdate,
  subagentScheduleRefusal,
} from '../packages/dsh-adapter/test/fixtures/alpha211-contract.js'
import {
  endpoint,
  transportOptions,
  wrappedResponse,
} from '../packages/dsh-adapter/test/support/contract-harness.js'

describe('alpha211 Adapter to Application, Host and protocol projection', () => {
  it('carries the non-mutating Schedule refusal through the Application and Host schema', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, subagentScheduleRefusal))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    try {
      const value = await handleScheduleFeatureRequest(
        {
          type: 'schedule.update',
          requestId: 'request-1',
          payload: scheduleUpdate,
        },
        new ScheduleUseCases(new Alpha211ScheduleRepository(transport)),
        new AbortController().signal,
      )
      const payload = featureResponsePayloadSchema.parse(value)
      if (payload.kind !== 'schedule.updated') throw new Error('unexpected Host response')
      expect(payload.result).toEqual(subagentScheduleRefusal)
      // A delegated task remains deletable: the refusal belongs only to update.
      expect(
        featureResponsePayloadSchema.safeParse({ kind: 'schedule.deleted', result: subagentScheduleRefusal })
          .success,
      ).toBe(false)
    } finally {
      await transport.close()
    }
  })

  it('projects recovered installed versions to the UI and rejects Host-only source fields', async () => {
    const fetch: typeof globalThis.fetch = (_url, init) =>
      Promise.resolve(wrappedResponse(init, installedBundle))
    const transport = new AlphaLoopbackApiClient({ endpoint, ...transportOptions(fetch) })
    try {
      const result = await new Alpha211PluginBundleRepository(transport).waitForInstall('install-1')
      const payload = featureResponsePayloadSchema.parse({ kind: 'plugin.install.waited', result })
      if (payload.kind !== 'plugin.install.waited' || payload.result === null)
        throw new Error('missing recovered result')
      expect(payload.result.version).toBe('1.2.3')
      for (const version of ['word', '1.2', '01.2.3', '1.2.3-01', '1.2.3+'])
        expect(
          featureResponsePayloadSchema.safeParse({
            ...payload,
            result: { ...payload.result, version },
          }).success,
        ).toBe(false)
      expect(
        featureResponsePayloadSchema.safeParse({
          ...payload,
          result: { ...payload.result, version: '1.2.3-alpha.1+build.2' },
        }).success,
      ).toBe(true)
      expect(
        featureResponsePayloadSchema.safeParse({
          ...payload,
          result: { ...payload.result, source: installedBundle.source },
        }).success,
      ).toBe(false)
    } finally {
      await transport.close()
    }
  })
})
