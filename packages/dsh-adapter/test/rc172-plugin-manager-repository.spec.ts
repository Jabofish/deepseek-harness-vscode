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

const bundleFixture = {
  name: '@dsh-community/optional-review',
  version: '1.2.3',
  meta: {
    title: { en: 'Optional review', zh: '可选审查' },
    description: { en: 'Reviews a proposed change.' },
    icon: 'https://assets.invalid/icon.svg',
  },
  enabled: false,
  installed: false,
  optional: true,
  removable: false,
  rows: [{ rowId: 'review', moduleName: '@dsh-community/optional-review/review', entryId: 'review:entry' }],
  overrides: [],
}

describe('DSH 0.1.7-rc.2 Plugin Manager Remote contract', () => {
  it('projects live bundles and plugin entries while omitting untrusted metadata', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: [
          { ...bundleFixture, meta: { ...bundleFixture.meta, error: 'private metadata diagnostic' } },
          {
            name: '@profile/managed-dependency',
            enabled: true,
            installed: true,
            optional: false,
            removable: true,
            rows: [],
            overrides: [],
            error: { code: 'incompatible-version', diagnostic: 'private profile path' },
          },
        ],
      },
      {
        ok: true,
        value: [
          {
            entryId: 'review:entry',
            moduleName: '@dsh-community/optional-review/review',
            enabled: true,
            fiberPhase: 'active',
          },
        ],
      },
    ])
    const signal = new AbortController().signal
    const repository = new Rc172PluginBundleRepository(transport)

    await expect(repository.listBundles(signal)).resolves.toEqual([
      {
        name: '@dsh-community/optional-review',
        version: '1.2.3',
        title: { en: 'Optional review', zh: '可选审查' },
        description: { en: 'Reviews a proposed change.' },
        enabled: false,
        installed: false,
        optional: true,
        removable: false,
        rows: [
          { rowId: 'review', moduleName: '@dsh-community/optional-review/review', entryId: 'review:entry' },
        ],
        overrides: [],
      },
      {
        name: '@profile/managed-dependency',
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [],
        overrides: [],
        errorCode: 'incompatible-version',
      },
    ])
    await expect(repository.listPlugins(signal)).resolves.toEqual([
      {
        entryId: 'review:entry',
        moduleName: '@dsh-community/optional-review/review',
        enabled: true,
        fiberPhase: 'active',
      },
    ])
    expect(calls.map(({ endpoint }) => endpoint)).toEqual([
      'pluginManager/listBundles',
      'pluginManager/listPlugins',
    ])
    expect(JSON.stringify(calls)).not.toContain('private')
  })

  it('reads registries and maps package inspection refusals without upstream reason text', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          registry: null,
          fallbackRegistries: ['https://mirror.example.test/'],
          resolved: 'https://registry.example.test/',
        },
      },
      {
        ok: true,
        value: {
          status: 'refused',
          problem: 'network',
          reason: 'private endpoint/path token=secret',
          registries: ['https://registry.example.test/'],
        },
      },
    ])
    const repository = new Rc172PluginBundleRepository(transport)

    await expect(repository.registries()).resolves.toEqual({
      registry: null,
      fallbackRegistries: ['https://mirror.example.test/'],
      resolved: 'https://registry.example.test/',
    })
    await expect(
      repository.inspect('@dsh-community/missing', 'https://mirror.example.test/'),
    ).resolves.toEqual({
      status: 'refused',
      problem: 'network',
      registries: ['https://registry.example.test/'],
    })
    expect(calls[1]).toEqual({
      endpoint: 'pluginManager/inspect',
      args: { spec: '@dsh-community/missing', options: { registry: 'https://mirror.example.test/' } },
      signal: undefined,
    })
  })

  it('accepts the upstream-supported SSH Git install form without allowing embedded credentials', async () => {
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: { status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' },
      },
    ])
    const repository = new Rc172PluginBundleRepository(transport)

    await expect(repository.inspect('git+ssh://git@github.com/a/b.git')).resolves.toEqual({
      status: 'accepted',
      kind: 'git',
      bundle: null,
      registry: null,
      host: 'github.com',
    })
    expect(calls).toEqual([
      {
        endpoint: 'pluginManager/inspect',
        args: { spec: 'git+ssh://git@github.com/a/b.git' },
        signal: undefined,
      },
    ])

    const invalid = recordingTransport([])
    await expect(
      new Rc172PluginBundleRepository(invalid.transport).inspect('git+ssh://git:secret@github.com/a/b.git'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(
      new Rc172PluginBundleRepository(invalid.transport).inspect('git://user:secret@example.test/a/b.git'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(invalid.calls).toHaveLength(0)
  })

  it('routes install, request cancellation, removal, and individual plugin enablement to RC2 Remotes', async () => {
    const spec = 'https://git.example.test/private/repo.git'
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          stage: 'install',
          target: spec,
          changed: false,
          application: 'failed',
          enabled: true,
          error: { code: 'operation-error', diagnostic: 'C:\\Users\\private\\profile\\nBearer secret' },
          packageResult: {
            exitCode: 1,
            output: 'registry token=secret',
            logPath: 'C:\\Users\\private\\pnpm.log',
            kind: 'permission',
          },
          failedAt: 'registry',
        },
      },
      { ok: true, value: { status: 'too-late' } },
      {
        ok: true,
        value: {
          target: '@dsh-community/optional-review',
          stage: 'remove',
          changed: true,
          application: 'applied',
        },
      },
      {
        ok: true,
        value: {
          target: 'review:entry',
          stage: 'enable',
          changed: true,
          application: 'applied',
          enabled: false,
        },
      },
    ])
    const repository = new Rc172PluginBundleRepository(transport)

    await expect(repository.installBundle(spec, { requestId: 'install-1', registry: null })).resolves.toEqual(
      {
        name: 'plugin',
        changed: false,
        application: 'failed',
        enabled: true,
        stage: 'install',
        errorCode: 'operation-error',
        failureKind: 'permission',
        failedAt: 'registry',
      },
    )
    await expect(repository.cancelInstall('install-1')).resolves.toEqual({ status: 'too-late' })
    await expect(repository.removeBundle('@dsh-community/optional-review')).resolves.toMatchObject({
      stage: 'remove',
      changed: true,
    })
    await expect(repository.setPluginEnabled('review:entry', false)).resolves.toMatchObject({
      enabled: false,
      stage: 'enable',
    })
    expect(calls).toEqual([
      {
        endpoint: 'pluginManager/installBundle',
        args: { spec, options: { enabled: true, requestId: 'install-1', registry: null } },
        signal: undefined,
      },
      { endpoint: 'pluginManager/cancelInstall', args: { requestId: 'install-1' }, signal: undefined },
      {
        endpoint: 'pluginManager/removeBundle',
        args: { name: '@dsh-community/optional-review' },
        signal: undefined,
      },
      {
        endpoint: 'pluginManager/setPluginEnabled',
        args: { id: 'review:entry', enabled: false },
        signal: undefined,
      },
    ])
    expect(JSON.stringify(calls)).not.toContain('secret')
  })

  it('maps the exact successful RC2 install result after its stage and target advance to bundle activation', async () => {
    const bundleName = '@dsh-community/optional-review'
    const spec = 'git+https://github.com/dsh-community/optional-review.git'
    const { transport, calls } = recordingTransport([
      {
        ok: true,
        value: {
          changed: true,
          application: 'applied',
          stage: 'enable',
          target: bundleName,
          enabled: true,
          bundle: bundleName,
          registries: [null],
        },
      },
    ])
    const repository = new Rc172PluginBundleRepository(transport)

    await expect(repository.installBundle(spec, { requestId: 'install-success' })).resolves.toEqual({
      name: bundleName,
      changed: true,
      application: 'applied',
      enabled: true,
      stage: 'install',
      bundle: bundleName,
    })
    expect(calls).toEqual([
      {
        endpoint: 'pluginManager/installBundle',
        args: { spec, options: { enabled: true, requestId: 'install-success' } },
        signal: undefined,
      },
    ])
  })

  it('maps cancelled installs with their original target and rejects mismatched install targets', async () => {
    const spec = 'dsh-package'
    const cancelled = recordingTransport([
      {
        ok: true,
        value: { changed: false, application: 'cancelled', stage: 'install', target: spec, enabled: true },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(cancelled.transport).installBundle(spec, {
        requestId: 'install-cancelled',
      }),
    ).resolves.toEqual({
      name: 'plugin',
      changed: false,
      application: 'cancelled',
      enabled: true,
      stage: 'install',
    })

    const mismatched = recordingTransport([
      {
        ok: true,
        value: {
          changed: false,
          application: 'cancelled',
          stage: 'install',
          target: 'different-spec',
          enabled: true,
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(mismatched.transport).installBundle(spec, {
        requestId: 'install-mismatch',
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('rejects a successful install whose returned target does not match its bundle', async () => {
    const repository = new Rc172PluginBundleRepository(
      recordingTransport([
        {
          ok: true,
          value: {
            changed: true,
            application: 'applied',
            stage: 'enable',
            target: '@dsh-community/other',
            enabled: true,
            bundle: '@dsh-community/optional-review',
          },
        },
      ]).transport,
    )
    await expect(
      repository.installBundle('optional-review', { requestId: 'install-target-mismatch' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('recovers active RC2 install results, including the stage transition and settled-null contract', async () => {
    const succeeded = recordingTransport([
      {
        ok: true,
        value: {
          target: bundleFixture.name,
          stage: 'enable',
          bundle: bundleFixture.name,
          changed: true,
          application: 'applied',
          enabled: true,
        },
      },
    ])
    const succeededRepository = new Rc172PluginBundleRepository(succeeded.transport)
    await expect(succeededRepository.waitForInstall('install-restore')).resolves.toEqual({
      name: bundleFixture.name,
      changed: true,
      application: 'applied',
      enabled: true,
      stage: 'install',
      bundle: bundleFixture.name,
    })
    expect(succeeded.calls).toEqual([
      {
        endpoint: 'pluginManager/waitForInstall',
        args: { requestId: 'install-restore' },
        signal: undefined,
      },
    ])

    const failed = recordingTransport([
      {
        ok: true,
        value: {
          target: 'git+https://private.example.test/plugin.git',
          stage: 'install',
          changed: false,
          application: 'failed',
          enabled: true,
          failedAt: 'spec-host',
          packageResult: { kind: 'network' },
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(failed.transport).waitForInstall('install-failed'),
    ).resolves.toMatchObject({
      name: 'plugin',
      stage: 'install',
      application: 'failed',
      failureKind: 'network',
    })

    const cancelled = recordingTransport([
      {
        ok: true,
        value: {
          target: '@dsh-community/review-layer',
          stage: 'install',
          changed: false,
          application: 'cancelled',
          enabled: true,
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(cancelled.transport).waitForInstall('install-cancelled'),
    ).resolves.toMatchObject({
      name: 'plugin',
      stage: 'install',
      application: 'cancelled',
    })

    const settled = recordingTransport([{ ok: true, value: null }])
    await expect(
      new Rc172PluginBundleRepository(settled.transport).waitForInstall('install-settled'),
    ).resolves.toBeNull()

    const invalidTarget = recordingTransport([
      {
        ok: true,
        value: { target: '', stage: 'install', changed: false, application: 'cancelled', enabled: true },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(invalidTarget.transport).waitForInstall('install-invalid'),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })

    const mismatchedBundle = recordingTransport([
      {
        ok: true,
        value: {
          target: '@dsh-community/other',
          stage: 'enable',
          bundle: bundleFixture.name,
          changed: true,
          application: 'applied',
          enabled: true,
        },
      },
    ])
    await expect(
      new Rc172PluginBundleRepository(mismatchedBundle.transport).waitForInstall('install-mismatched'),
    ).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
  })

  it('rejects malformed responses, credential-bearing inputs, and dispatch after cancellation', async () => {
    const malformedList = recordingTransport([{ ok: true, value: [{ name: 'x', optional: true }] }])
    await expect(
      new Rc172PluginBundleRepository(malformedList.transport).listBundles(),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

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

    const invalidInput = recordingTransport([])
    const invalidRepository = new Rc172PluginBundleRepository(invalidInput.transport)
    await expect(
      invalidRepository.inspect('pkg', 'https://user:secret@registry.example.test/'),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(
      invalidRepository.installBundle('https://git.example.test/repo?token=secret', {
        requestId: 'install-3',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    await expect(invalidRepository.inspect('git://user:secret@example.test/a/b.git')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(invalidInput.calls).toHaveLength(0)

    const cancelled = recordingTransport([])
    const controller = new AbortController()
    controller.abort()
    await expect(
      new Rc172PluginBundleRepository(cancelled.transport).listBundles(controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled.calls).toHaveLength(1)
  })
})
