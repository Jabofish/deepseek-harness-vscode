import { describe, expect, it, vi } from 'vitest'
import type { DshTransport } from '../../contracts.js'
import { Rc172PluginBundleRepository } from './plugin-manager-repository.js'

function repository(answers: Readonly<Record<string, unknown>>): {
  readonly repository: Rc172PluginBundleRepository
  readonly calls: readonly { readonly endpoint: string; readonly args: Readonly<Record<string, unknown>> }[]
  readonly transport: DshTransport
} {
  const calls: { readonly endpoint: string; readonly args: Readonly<Record<string, unknown>> }[] = []
  const transport = {
    remoteRequest: vi.fn((endpoint: string, args: Readonly<Record<string, unknown>>) => {
      calls.push({ endpoint, args })
      return Promise.resolve(answers[endpoint])
    }),
  } as unknown as DshTransport
  return { repository: new Rc172PluginBundleRepository(transport), calls, transport }
}

describe('RC2 Plugin Manager repository', () => {
  it('marks local install validation as not sent but keeps Remote failures indeterminate', async () => {
    const fixture = repository({})
    await expect(
      fixture.repository.installBundle('https://git.example.test/repo?token=secret', {
        requestId: 'install-invalid',
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_NOT_STARTED', retryable: true })
    expect(fixture.calls).toEqual([])

    const disconnected = Object.assign(new Error('connection dropped after request dispatch'), {
      code: 'BACKEND_UNREACHABLE',
    })
    const remoteRequest = vi.spyOn(fixture.transport, 'remoteRequest').mockRejectedValueOnce(disconnected)
    await expect(
      fixture.repository.installBundle('@dsh-community/review-layer', { requestId: 'install-disconnected' }),
    ).rejects.toBe(disconnected)
    expect(remoteRequest).toHaveBeenCalledWith(
      'pluginManager/installBundle',
      {
        spec: '@dsh-community/review-layer',
        options: { enabled: true, requestId: 'install-disconnected' },
      },
      undefined,
    )
  })
})
