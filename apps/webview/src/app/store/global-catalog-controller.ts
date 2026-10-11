import type { ProtocolClient } from '../protocol-client.js'
import { parsePresetRoster } from './agent-config.js'
import { withPresetSelectionEnabled } from './host-message-reducers.js'
import { requestId } from './ids.js'
import {
  sameModelDescriptorList,
  sameModelProviderList,
  samePresetDescriptorList,
  strictListValues,
} from './list-equality.js'
import { isModelDescriptor, isModelProvider } from './model-catalog.js'
import type { StateSetter } from './types.js'
import { object } from './unknown-record.js'

export interface GlobalCatalogController {
  readonly invalidate: () => void
  readonly refreshModels: () => Promise<void>
  readonly refreshAll: (isCurrent: () => boolean) => Promise<void>
}

/** One owner for global model reads issued by startup, settings and Host events. */
export function createGlobalCatalogController({
  client,
  setState,
  isDisposed,
  nextPresetRosterGeneration,
  isPresetRosterCurrent,
}: {
  readonly client: Pick<ProtocolClient, 'request'>
  readonly setState: StateSetter
  readonly isDisposed: () => boolean
  readonly nextPresetRosterGeneration: () => number
  readonly isPresetRosterCurrent: (generation: number) => boolean
}): GlobalCatalogController {
  let modelGeneration = 0
  const beginModels = (): (() => boolean) => {
    const generation = ++modelGeneration
    return () => !isDisposed() && generation === modelGeneration
  }
  const readModels = (): readonly Promise<unknown>[] => [
    client.request<unknown>({ type: 'providers.list', requestId: requestId() }),
    client.request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} }),
  ]
  const applyModels = (results: readonly PromiseSettledResult<unknown>[], isCurrent: () => boolean): void => {
    if (!isCurrent()) return
    const providerResult = results[0]
    const rawProviders = providerResult?.status === 'fulfilled' ? providerResult.value : undefined
    const rows = Array.isArray(rawProviders) ? rawProviders : object(rawProviders)?.items
    // A broken provider row must not hide the other healthy providers, but a
    // failed or malformed directory envelope must not clear the last good list.
    const providers = Array.isArray(rows) ? rows.filter(isModelProvider) : undefined
    const modelResult = results[1]
    const models =
      modelResult?.status === 'fulfilled' ? strictListValues(modelResult.value, isModelDescriptor) : undefined
    setState((current) => {
      if (!isCurrent()) return current
      const nextProviders =
        providers === undefined || sameModelProviderList(current.providers, providers)
          ? current.providers
          : providers
      const nextModels =
        models === undefined || sameModelDescriptorList(current.models, models) ? current.models : models
      return nextProviders === current.providers && nextModels === current.models
        ? current
        : { ...current, providers: nextProviders, models: nextModels }
    })
  }
  return {
    invalidate: (): void => {
      modelGeneration += 1
      nextPresetRosterGeneration()
    },
    refreshModels: async (): Promise<void> => {
      if (isDisposed()) return
      const isCurrent = beginModels()
      applyModels(await Promise.allSettled(readModels()), isCurrent)
    },
    refreshAll: async (isCurrent: () => boolean): Promise<void> => {
      if (isDisposed() || !isCurrent()) return
      const modelsCurrent = beginModels()
      const rosterGeneration = nextPresetRosterGeneration()
      const results = await Promise.allSettled([
        ...readModels(),
        client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
      ])
      applyModels(results, () => isCurrent() && modelsCurrent())
      if (isDisposed() || !isCurrent() || !isPresetRosterCurrent(rosterGeneration)) return
      const result = results[2]
      const roster = result?.status === 'fulfilled' ? parsePresetRoster(result.value) : undefined
      if (roster === undefined) return
      setState((current) => {
        const presets = samePresetDescriptorList(current.presets, roster.presets)
          ? current.presets
          : roster.presets
        return presets === current.presets && current.presetSelectionEnabled === roster.modeSelectionEnabled
          ? current
          : withPresetSelectionEnabled({ ...current, presets }, roster.modeSelectionEnabled)
      })
    },
  }
}
