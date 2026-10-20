import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentConfiguration, AgentPresetDescriptor, DshBackend } from '@dsh-vscode/domain'
import { AppError } from '@dsh-vscode/domain'

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
  it('leaves an empty optional registry to the DSH host default', () => {
    expect(resolveSessionConfigurationForRoster({ ...requested, preset: '' }, [])).toEqual({
      ...requested,
      preset: '',
    })
  })

  it('keeps a requested preset only when it exists in the host roster', () => {
    expect(
      resolveSessionConfigurationForRoster({ ...requested, preset: 'custom-mode' }, [
        defaultPreset,
        customPreset,
      ]).preset,
    ).toBe('custom-mode')
  })

  it.each([
    {
      name: 'a missing choice does not silently use the healthy default',
      preset: 'missing',
      roster: [customPreset, defaultPreset],
    },
    {
      name: 'a broken choice does not silently use a healthy candidate',
      preset: 'standard',
      roster: [{ ...defaultPreset, broken: 'unavailable' }, customPreset],
    },
    {
      name: 'a missing choice does not silently use the first candidate',
      preset: 'missing',
      roster: [customPreset, { ...defaultPreset, isDefault: false }],
    },
    {
      name: 'an entirely broken roster cannot run an explicit listed choice',
      preset: 'custom-mode',
      roster: [
        { ...defaultPreset, broken: 'unavailable' },
        { ...customPreset, broken: 'unavailable' },
      ],
    },
  ])('$name', ({ preset, roster }) => {
    expect(() => resolveSessionConfigurationForRoster({ ...requested, preset }, roster)).toThrow(AppError)
  })

  it('rejects a stale explicit choice even when the registry has become empty', () => {
    expect(() => resolveSessionConfigurationForRoster(requested, [])).toThrow(AppError)
  })

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

  it('omits optional transport fields whose value is undefined', () => {
    expect(
      resolveSessionConfigurationForRoster(
        {
          ...requested,
          sandboxMode: undefined,
          approvalPolicy: undefined,
          model: { ...requested.model, reasoningLevel: undefined },
        },
        [defaultPreset],
      ),
    ).toEqual(requested)
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
  it('resolves a create configuration from the backend roster with the caller signal', async () => {
    const { list, setConfiguration, useCases } = harness()
    const controller = new AbortController()
    list.mockResolvedValue({ presets: [], authorable: false })

    await expect(
      useCases.resolveSessionConfiguration({ ...requested, preset: '' }, controller.signal),
    ).resolves.toEqual({
      ...requested,
      preset: '',
    })
    expect(list).toHaveBeenCalledExactlyOnceWith(controller.signal)
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it('uses the same resolution rules before writing a session configuration', async () => {
    const { list, setConfiguration, useCases } = harness()
    const controller = new AbortController()

    await useCases.setSessionConfiguration('session', requested, controller.signal)

    expect(list).toHaveBeenCalledExactlyOnceWith(controller.signal)
    expect(setConfiguration).toHaveBeenCalledExactlyOnceWith('session', requested, controller.signal)
  })

  it('rejects a stale choice before writing any configuration', async () => {
    const { setConfiguration, useCases } = harness()
    await expect(
      useCases.setSessionConfiguration('session', { ...requested, preset: 'missing' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it('propagates a roster failure without applying a guessed configuration', async () => {
    const { list, setConfiguration, useCases } = harness()
    const error = new AppError({
      code: 'BACKEND_UNREACHABLE',
      message: 'Roster unavailable',
      retryable: true,
    })
    list.mockRejectedValue(error)

    await expect(useCases.setSessionConfiguration('session', requested)).rejects.toBe(error)
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it('does not read or write when the operation is already cancelled', async () => {
    const { list, setConfiguration, useCases } = harness()
    const controller = new AbortController()
    controller.abort()

    await expect(
      useCases.setSessionConfiguration('session', requested, controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(list).not.toHaveBeenCalled()
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it('does not write a late roster response after cancellation', async () => {
    const { list, setConfiguration, useCases } = harness()
    const controller = new AbortController()
    list.mockImplementation(() => {
      controller.abort()
      return Promise.resolve({ presets: [defaultPreset], authorable: false })
    })

    await expect(
      useCases.setSessionConfiguration('session', requested, controller.signal),
    ).rejects.toHaveProperty('name', 'AbortError')
    expect(setConfiguration).not.toHaveBeenCalled()
  })

  it('does not apply a late configuration to a replacement backend with the same session id', async () => {
    const { list, setConfiguration, useCases, service } = harness()
    const replacementWrite = vi.fn<DshBackend['sessions']['setConfiguration']>()
    list.mockImplementation(() => {
      service.attach(
        {
          events: { subscribe: () => () => undefined },
          sessions: { setConfiguration: replacementWrite },
        } as unknown as DshBackend,
        () => undefined,
      )
      return Promise.resolve({ presets: [defaultPreset], authorable: false })
    })

    await expect(useCases.setSessionConfiguration('session', requested)).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    })
    expect(setConfiguration).not.toHaveBeenCalled()
    expect(replacementWrite).not.toHaveBeenCalled()
  })
})
