import type { ProtocolClient } from '../protocol-client.js'
import { parsePresetRoster } from './agent-config.js'
import { withPresetSelectionEnabled } from './host-message-reducers.js'
import { requestId } from './ids.js'
import {
  sameModelDescriptorList,
  sameModelProviderList,
  samePresetDescriptorList,
  sameStringList,
  strictListValues,
} from './list-equality.js'
import { isModelDescriptor, isModelProvider } from './model-catalog.js'
import type { StateSetter } from './types.js'
import { object } from './unknown-record.js'
import { parsePermissionCatalog } from './permission-catalog.js'

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
  const applyProviders = (value: unknown, isCurrent: () => boolean): void => {
    if (!isCurrent()) return
    const rows = Array.isArray(value) ? value : object(value)?.items
    // A broken provider row must not hide the other healthy providers, but a
    // failed or malformed directory envelope must not clear the last good list.
    const providers = Array.isArray(rows) ? rows.filter(isModelProvider) : undefined
    setState((current) => {
      if (!isCurrent()) return current
      return providers === undefined || sameModelProviderList(current.providers, providers)
        ? current
        : { ...current, providers }
    })
  }
  const applyModels = (value: unknown, isCurrent: () => boolean): void => {
    if (!isCurrent()) return
    const models = strictListValues(value, isModelDescriptor)
    setState((current) =>
      !isCurrent() || models === undefined || sameModelDescriptorList(current.models, models)
        ? current
        : { ...current, models },
    )
  }
  const readModels = async (isCurrent: () => boolean): Promise<void> => {
    await Promise.allSettled([
      client
        .request<unknown>({ type: 'providers.list', requestId: requestId() })
        .then((value) => applyProviders(value, isCurrent)),
      client
        .request<unknown>({ type: 'models.list', requestId: requestId(), payload: {} })
        .then((value) => applyModels(value, isCurrent)),
    ])
  }
  return {
    invalidate: (): void => {
      modelGeneration += 1
      nextPresetRosterGeneration()
      setState((current) =>
        (current.newSessionPermissionPresets?.length ?? 0) === 0 &&
        current.newSessionPermissionDefault === undefined
          ? current
          : { ...current, newSessionPermissionPresets: [], newSessionPermissionDefault: undefined },
      )
    },
    refreshModels: async (): Promise<void> => {
      if (isDisposed()) return
      const isCurrent = beginModels()
      await readModels(isCurrent)
    },
    refreshAll: async (isCurrent: () => boolean): Promise<void> => {
      if (isDisposed() || !isCurrent()) return
      const modelsCurrent = beginModels()
      const rosterGeneration = nextPresetRosterGeneration()
      const applyPermissions = (value: unknown): void => {
        if (isDisposed() || !isCurrent() || !isPresetRosterCurrent(rosterGeneration)) return
        const catalog = parsePermissionCatalog(value)
        setState((current) => {
          const next = catalog?.items ?? []
          return sameStringList(current.newSessionPermissionPresets ?? [], next) &&
            current.newSessionPermissionDefault === catalog?.defaultPreset
            ? current
            : {
                ...current,
                newSessionPermissionPresets: next,
                newSessionPermissionDefault: catalog?.defaultPreset,
              }
        })
      }
      const applyRoster = (value: unknown): void => {
        if (isDisposed() || !isCurrent() || !isPresetRosterCurrent(rosterGeneration)) return
        const roster = parsePresetRoster(value)
        if (roster === undefined) return
        setState((current) => {
          const presets = samePresetDescriptorList(current.presets, roster.presets)
            ? current.presets
            : roster.presets
          return presets === current.presets && current.presetSelectionEnabled === roster.modeSelectionEnabled
            ? current
            : withPresetSelectionEnabled({ ...current, presets }, roster.modeSelectionEnabled)
        })
      }
      // Publish each complete directory as it arrives. A slow provider's
      // settings/credentials must not withhold usable models or preset choices.
      await Promise.allSettled([
        readModels(() => isCurrent() && modelsCurrent()),
        client.request<unknown>({ type: 'preset.list', requestId: requestId() }).then(applyRoster),
        client
          .request<unknown>({ type: 'permissions.presets.list', requestId: requestId() })
          .then(applyPermissions, () => applyPermissions(undefined)),
      ])
    },
  }
}
