import { describe, expect, it } from 'vitest'
import type { DshTransport } from '../src/contracts.js'
import { Rc172PluginBundleRepository } from '../src/versions/rc172/plugin-manager-repository.js'

interface RemoteCall {
  readonly endpoint: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal | undefined
}

function recordingTransport(responses: readonly unknown[]): {
  readonly transport: DshTransport
  readonly calls: RemoteCall[]
} {
  const pending = [...responses]
  const calls: RemoteCall[] = []
  const transport: DshTransport = {
    request: <TResponse>() =>
      Promise.reject<TResponse>(new Error('Plugin Manager does not use ordinary RPC')),
    remoteRequest: <TResponse>(
      endpoint: string,
      args: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ) => {
      calls.push({ endpoint, args, signal })
      signal?.throwIfAborted()
      const response = pending.shift()
      return response === undefined
        ? Promise.reject<TResponse>(new Error('unexpected Plugin Manager Remote request'))
        : Promise.resolve(response as TResponse)
    },
    openEventStream: async function* () {
      /* Plugin Manager Remote calls do not open streams. */
    },
    close: () => Promise.resolve(),
  }
  return { transport, calls }
}

describe('DSH 0.1.7-rc.2 optional bundle Remote contract', () => {
  it('dynamically projects optional entries including installation-provided bundles and omits private diagnostics', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: [
          {
            name: '@dsh-community/optional-review',
            version: '1.2.3',
            meta: {
              title: { en: 'Optional review', zh: '可选审查' },
              description: { en: 'Reviews a proposed change.' },
              icon: 'https://assets.invalid/icon.svg',
              error: 'sensitive metadata diagnostic',
            },
            description: 'Fallback description',
            enabled: false,
            installed: false,
            optional: true,
            removable: false,
            rows: [{ moduleName: 'private-row-module' }],
            overrides: ['private-row-id'],
          },
          {
            name: '@profile/managed-dependency',
            enabled: true,
            installed: true,
            optional: false,
            removable: true,
            rows: [],
            overrides: [],
          },
          {
            name: '@dsh-community/selected-review',
            enabled: true,
            installed: true,
            optional: true,
            removable: false,
            error: { code: 'incompatible-version', diagnostic: 'private profile path and runtime detail' },
            rows: [],
            overrides: [],
          },
        ],
      },
    ])
    const signal = new AbortController().signal

    const result = await new Rc172PluginBundleRepository(transport).listOptionalBundles(signal)
    expect(result).toEqual([
      {
        name: '@dsh-community/optional-review',
        version: '1.2.3',
        title: { en: 'Optional review', zh: '可选审查' },
        description: { en: 'Reviews a proposed change.' },
        enabled: false,
        installed: false,
        hasIssue: false,
      },
      {
        name: '@dsh-community/selected-review',
        enabled: true,
        installed: true,
        hasIssue: true,
      },
    ])
    expect(calls).toEqual([{ endpoint: 'pluginManager/listBundles', args: {}, signal }])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('sends only the exact dynamic bundle name and enabled flag, and sanitizes a failed result', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          changed: false,
          application: 'failed',
          stage: 'enable',
          target: '@dsh-community/optional-review',
          enabled: true,
          error: { code: 'incompatible-version', diagnostic: 'private profile path and dependency tree' },
          warnings: ['private-loader-row-id'],
        },
      },
    ])
    const signal = new AbortController().signal

    const result = await new Rc172PluginBundleRepository(transport).setBundleEnabled(
      '@dsh-community/optional-review',
      true,
      signal,
    )
    expect(result).toEqual({
      name: '@dsh-community/optional-review',
      changed: false,
      application: 'failed',
      enabled: true,
      errorCode: 'incompatible-version',
    })
    expect(calls).toEqual([
      {
        endpoint: 'pluginManager/setBundleEnabled',
        args: { name: '@dsh-community/optional-review', enabled: true },
        signal,
      },
    ])
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('preserves immediate, restart-required, overridden, and cancelled outcomes', async () => {
    for (const application of ['applied', 'restart-required', 'overridden', 'cancelled'] as const) {
      const { transport } = recordingTransport([
        {
          ok: true,
          value: {
            changed: true,
            application,
            stage: 'enable',
            target: '@dsh-community/optional-review',
            enabled: false,
          },
        },
      ])
      await expect(
        new Rc172PluginBundleRepository(transport).setBundleEnabled('@dsh-community/optional-review', false),
      ).resolves.toMatchObject({ application, changed: true, enabled: false })
    }
  })

  it('rejects malformed catalog and change records and propagates cancellation before dispatch', async () => {
    const malformedList = recordingTransport([{ ok: true, value: [{ name: 'x', optional: true }] }])
    await expect(
      new Rc172PluginBundleRepository(malformedList.transport).listOptionalBundles(),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })

    const malformedChange = recordingTransport([
      {
        ok: true,
        value: {
          changed: true,
          application: 'applied',
          stage: 'remove',
          target: '@dsh-community/optional-review',
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(malformedChange.transport).setBundleEnabled(
        '@dsh-community/optional-review',
        true,
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const missingEnabled = recordingTransport([
      {
        ok: true,
        value: {
          changed: true,
          application: 'applied',
          stage: 'enable',
          target: '@dsh-community/optional-review',
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(missingEnabled.transport).setBundleEnabled(
        '@dsh-community/optional-review',
        true,
      ),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const cancelled = recordingTransport([])
    const controller = new AbortController()
    controller.abort()
    await expect(
      new Rc172PluginBundleRepository(cancelled.transport).listOptionalBundles(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled.calls).toHaveLength(1)
  })
})
