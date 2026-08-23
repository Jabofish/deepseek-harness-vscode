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
