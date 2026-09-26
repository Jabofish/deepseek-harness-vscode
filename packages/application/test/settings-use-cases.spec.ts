import { describe, expect, it, vi } from 'vitest'
import type { DshBackend } from '@dsh-vscode/domain'
import { BackendService } from '../src/services/backend-service.js'
import { SettingsUseCases } from '../src/use-cases/settings-use-cases.js'

function useCasesFor(settings: unknown): SettingsUseCases {
  const backend = {
    settings,
    events: { subscribe: vi.fn(() => () => undefined) },
  } as unknown as DshBackend
  const service = new BackendService()
  service.attach(backend, () => undefined)
  return new SettingsUseCases(service)
}

describe('SettingsUseCases', () => {
  it('reads schema and values through one atomic repository snapshot', async () => {
    const snapshot = {
      schema: {
        version: 'rc6-settings-v2',
        writable: true,
        hasDocument: false,
        fields: [],
        namespaces: [{ ns: 'shell', applies: 'live', revision: 4, userFields: [], secrets: [] }],
      },
      values: { shell: { timeoutMs: 12_000 } },
    }
    const readSnapshot = vi.fn().mockResolvedValue(snapshot)
    const settings = { readSnapshot, schema: vi.fn(), read: vi.fn() }

    await expect(useCasesFor(settings).read()).resolves.toBe(snapshot)

    expect(readSnapshot).toHaveBeenCalledTimes(1)
    expect(settings.schema).not.toHaveBeenCalled()
    expect(settings.read).not.toHaveBeenCalled()
  })

  it('forwards the displayed revision for update and unset compare-and-swap writes', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const unset = vi.fn().mockResolvedValue(undefined)
    const useCases = useCasesFor({ update, unset })

    await useCases.update('shell.timeoutMs', 20_000, 8)
    await useCases.unset('shell.timeoutMs', 8)

    expect(update).toHaveBeenCalledWith('shell.timeoutMs', 20_000, 8, undefined)
    expect(unset).toHaveBeenCalledWith('shell.timeoutMs', 8, undefined)
  })

  it('rejects an invalid batch revision before calling the repository', () => {
    const mutate = vi.fn()
    const useCases = useCasesFor({ mutate })

    expect(() => useCases.mutate('shell', [{ op: 'set', path: ['timeoutMs'], value: 20_000 }], -1)).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIGURATION' }),
    )
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps the settings repository receiver when opening its document', async () => {
    const settings = {
      marker: true,
      openDocument(this: { marker: boolean }, _signal?: AbortSignal): Promise<void> {
        if (!this.marker) throw new Error('settings repository receiver was lost')
        return Promise.resolve()
      },
    }

    await expect(useCasesFor(settings).openDocument()).resolves.toBeUndefined()
  })

  it('reports the capability as unavailable when the host does not expose document opening', async () => {
    await expect(useCasesFor({}).openDocument()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })
})
