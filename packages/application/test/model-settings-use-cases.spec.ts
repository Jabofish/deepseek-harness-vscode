import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentConfiguration, AgentPresetDescriptor, DshBackend } from '@dsh-vscode/domain'

import { BackendService } from '../src/services/backend-service.js'
import { ModelSettingsUseCases } from '../src/use-cases/model-settings-use-cases.js'
import { resolveSessionConfigurationForRoster } from '../src/use-cases/session-configuration.js'

const requested: AgentConfiguration = {
  preset: 'standard',
  toolMode: 'native',
  permissionPreset: 'workspace-write',
  planMode: false,
  model: { providerId: '', modelId: '' },
}
const defaultPreset: AgentPresetDescriptor = { id: 'standard', trust: 'system', isDefault: true }
const customPreset: AgentPresetDescriptor = { id: 'custom-mode', trust: 'user', isDefault: false }

describe('session preset resolution', () => {
  it('resolves an unchosen default using only healthy advertised presets', () => {
    expect(resolveSessionConfigurationForRoster({ ...requested, preset: '' }, [defaultPreset]).preset).toBe(
      'standard',
    )
    expect(
      resolveSessionConfigurationForRoster({ ...requested, preset: '' }, [
        { ...defaultPreset, broken: 'bad' },
        customPreset,
      ]).preset,
    ).toBe('custom-mode')
  })

  it('keeps model choices and the unknown-policy markers instead of writing display fallbacks', () => {
    const configuration: AgentConfiguration = {
      ...requested,
      permissionPresetKnown: false,
      planModeKnown: false,
      planMode: true,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      model: { providerId: 'local', modelId: 'chosen', reasoningLevel: 'high' },
    }
    const resolved = resolveSessionConfigurationForRoster(configuration, [defaultPreset])

    expect(resolved).toEqual({
      ...requested,
      planMode: true,
      permissionPresetKnown: false,
      planModeKnown: false,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      model: { providerId: 'local', modelId: 'chosen', reasoningLevel: 'high' },
    })
    expect(configuration.permissionPresetKnown).toBe(false)
    expect(configuration.planModeKnown).toBe(false)
    expect(resolved.model).not.toBe(configuration.model)
  })
})

function harness(): {
  readonly list: Mock<DshBackend['presets']['list']>
  readonly setConfiguration: Mock<DshBackend['sessions']['setConfiguration']>
  readonly useCases: ModelSettingsUseCases
  readonly service: BackendService
} {
  const list = vi.fn<DshBackend['presets']['list']>().mockResolvedValue({
    presets: [defaultPreset],
    authorable: false,
  })
  const setConfiguration = vi.fn<DshBackend['sessions']['setConfiguration']>().mockResolvedValue(undefined)
  const backend = {
    events: { subscribe: () => () => undefined },
    presets: { list },
    sessions: { setConfiguration },
  } as unknown as DshBackend
  const service = new BackendService()
  service.attach(backend, () => undefined)
  return { list, setConfiguration, useCases: new ModelSettingsUseCases(service), service }
}

describe('ModelSettingsUseCases configuration', () => {
  it('rejects a stale choice before writing any configuration', async () => {
    const { setConfiguration, useCases } = harness()
    await expect(
      useCases.setSessionConfiguration('session', { ...requested, preset: 'missing' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(setConfiguration).not.toHaveBeenCalled()
  })
})
