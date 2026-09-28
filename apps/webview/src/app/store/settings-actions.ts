import { translate } from '../../i18n.js'
import type { AgentConfiguration } from '@dsh-vscode/domain'
import type { ProtocolClient } from '../protocol-client.js'
import { requestId } from './ids.js'
import { parsePresetRoster } from './agent-config.js'
import {
  parseExtensionSettings,
  parseDshSettingsSnapshot,
  refreshProvidersAndModels,
} from './host-settings.js'
import { arraysEqual } from './list-equality.js'
import { parseCustomProviderCreateResult, parseDiscoveredModels } from './model-catalog.js'
import { withPresetSelectionEnabled } from './host-message-reducers.js'
import { object } from './unknown-record.js'
import type { AppActions, StateSetter } from './types.js'

export type PresetSessionSyncTarget =
  | {
      readonly kind: 'active'
      readonly sessionId: string
      readonly configuration: AgentConfiguration
    }
  | {
      readonly kind: 'pending'
      readonly revision: number
      readonly createdSessionId?: string
      readonly configuration: AgentConfiguration
    }

export interface SettingsActionHost {
  readonly client: ProtocolClient
  readonly setState: StateSetter
  readonly applyBusyEnter: (values: Readonly<Record<string, unknown>>) => void
  readonly capturePresetSessionTarget: () => PresetSessionSyncTarget | undefined
  readonly nextPresetRosterGeneration: () => number
  readonly isPresetRosterCurrent: (generation: number) => boolean
  readonly synchronizeBlankSessionPreset: (target: PresetSessionSyncTarget, preset: string) => Promise<void>
}

export type SettingsActionMethods = Pick<
  AppActions,
  | 'readSettings'
  | 'readDshSettings'
  | 'openDshSettingsDocument'
  | 'openKeyboardShortcuts'
  | 'updateDshSetting'
  | 'unsetDshSetting'
  | 'mutateDshSettings'
  | 'createCustomProvider'
  | 'configureProviderSecret'
  | 'removeProviderSecret'
  | 'configurePluginCredential'
  | 'removePluginCredential'
  | 'refreshModelCatalog'
  | 'discoverModels'
  | 'discoverCustomProviderModels'
  | 'loadPresetRoster'
  | 'readPresetDocument'
  | 'copyPreset'
  | 'removePreset'
  | 'openPresetDocument'
>

export function createSettingsActions(host: SettingsActionHost): SettingsActionMethods {
  const { client, setState, applyBusyEnter, capturePresetSessionTarget, synchronizeBlankSessionPreset } = host
  return {
    readSettings: async () => {
      return parseExtensionSettings(
        await client.request<unknown>({ type: 'extensionSettings.read', requestId: requestId() }),
      )
    },
    readDshSettings: async () => {
      const snapshot = parseDshSettingsSnapshot(
        await client.request<unknown>({ type: 'settings.read', requestId: requestId() }),
      )
      if (snapshot !== undefined) applyBusyEnter(snapshot.values)
      return snapshot
    },
    openDshSettingsDocument: async () => {
      await client.request<unknown>({ type: 'settings.openDocument', requestId: requestId() })
    },
    openKeyboardShortcuts: async () => {
      await client.request<unknown>({ type: 'settings.openKeyboardShortcuts', requestId: requestId() })
    },
    updateDshSetting: async (path, value, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.update',
        requestId: requestId(),
        payload: { path, value, expectedRevision },
      })
    },
    unsetDshSetting: async (path, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.unset',
        requestId: requestId(),
        payload: { path, expectedRevision },
      })
    },
    mutateDshSettings: async (namespace, operations, expectedRevision) => {
      await client.request<unknown>({
        type: 'settings.mutate',
        requestId: requestId(),
        payload: {
          namespace,
          operations: operations.map((operation) =>
            operation.op === 'set'
              ? { op: 'set', path: [...operation.path], value: operation.value }
              : { op: 'unset', path: [...operation.path] },
          ),
          expectedRevision,
        },
      })
    },
    createCustomProvider: async (draft) => {
      const result = parseCustomProviderCreateResult(
        await client.request<unknown>({
          type: 'provider.custom.create',
          requestId: requestId(),
          payload: {
            ...draft,
            collectionPath: [...draft.collectionPath],
            models: draft.models.map((model) => ({ ...model })),
          },
        }),
      )
      if (result === undefined) throw new Error(translate('settings.providerCreateMalformed'))
      return result
    },
    configureProviderSecret: async (providerId, field) => {
      const result = object(
        await client.request<unknown>({
          type: 'provider.secret.configure',
          requestId: requestId(),
          payload: { providerId, field },
        }),
      )
      return result?.configured === true
    },
    removeProviderSecret: async (providerId, field) => {
      await client.request<unknown>({
        type: 'provider.secret.remove',
        requestId: requestId(),
        payload: { providerId, field },
      })
    },
    configurePluginCredential: async (ref) => {
      const result = object(
        await client.request<unknown>({
          type: 'plugin.credential.configure',
          requestId: requestId(),
          payload: { ref },
        }),
      )
      return result?.configured === true
    },
    removePluginCredential: async (ref) => {
      await client.request<unknown>({
        type: 'plugin.credential.remove',
        requestId: requestId(),
        payload: { ref },
      })
    },
    refreshModelCatalog: async () => {
      await refreshProvidersAndModels(client, setState)
    },
    discoverModels: async (input) => {
      const value = await client.request<unknown>({
        type: 'models.discover',
        requestId: requestId(),
        payload: input,
      })
      const models = parseDiscoveredModels(value)
      if (models === undefined) throw new Error(translate('settings.discoveryMalformed'))
      return models
    },
    discoverCustomProviderModels: async (input) => {
      const value = await client.request<unknown>({
        type: 'models.discover.custom',
        requestId: requestId(),
        payload: input,
      })
      const models = parseDiscoveredModels(value)
      if (models === undefined) throw new Error(translate('settings.discoveryMalformed'))
      return models
    },
    loadPresetRoster: async () => {
      const target = capturePresetSessionTarget()
      const generation = host.nextPresetRosterGeneration()
      const roster = parsePresetRoster(
        await client.request<unknown>({ type: 'preset.list', requestId: requestId() }),
      )
      if (roster === undefined || !host.isPresetRosterCurrent(generation)) return roster
      const hostDefaultPreset = roster.presets.find((preset) => preset.isDefault)?.id
      setState((current) => {
        const presets = arraysEqual(current.presets, roster.presets) ? current.presets : roster.presets
        if (presets === current.presets && current.presetSelectionEnabled === roster.modeSelectionEnabled)
          return current
        return withPresetSelectionEnabled({ ...current, presets }, roster.modeSelectionEnabled)
      })
      if (target !== undefined && hostDefaultPreset !== undefined)
        await synchronizeBlankSessionPreset(target, hostDefaultPreset)
      return roster
    },
    readPresetDocument: async (presetId) => {
      const result = object(
        await client.request<unknown>({
          type: 'preset.read',
          requestId: requestId(),
          payload: { presetId },
        }),
      )
      if (result === undefined) return undefined
      if (
        typeof result.id !== 'string' ||
        (result.trust !== 'system' && result.trust !== 'user') ||
        typeof result.content !== 'string'
      )
        return undefined
      return {
        id: result.id,
        trust: result.trust,
        content: result.content,
        ...(typeof result.name === 'string' ? { name: result.name } : {}),
        ...(typeof result.description === 'string' ? { description: result.description } : {}),
      }
    },
    copyPreset: async (from, presetId, name) => {
      // The extension route resolves with the created preset id as a bare string.
      const created = await client.request<unknown>({
        type: 'preset.copy',
        requestId: requestId(),
        payload: {
          from,
          presetId,
          ...(name === undefined || name.trim() === '' ? {} : { name: name.trim() }),
        },
      })
      return typeof created === 'string' && created !== '' ? created : undefined
    },
    removePreset: async (presetId) => {
      await client.request<unknown>({
        type: 'preset.remove',
        requestId: requestId(),
        payload: { presetId },
      })
    },
    openPresetDocument: async (presetId) => {
      const result = object(
        await client.request<unknown>({
          type: 'preset.openDocument',
          requestId: requestId(),
          payload: { presetId },
        }),
      )
      if (result === undefined) return undefined
      if (result.opened === true) return { opened: true }
      if (typeof result.path === 'string') return { opened: false, path: result.path }
      return { opened: false }
    },
  }
}
