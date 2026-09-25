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

const bundle = {
  name: '@dsh-community/review-layer',
  version: '1.2.0',
  meta: { title: { en: 'Review layer', zh: '审查层' }, icon: 'https://invalid/icon.png' },
  enabled: false,
  installed: false,
  optional: true,
  removable: false,
  rows: [{ rowId: 'review', moduleName: '@dsh-community/review-layer/review', entryId: 'review:entry' }],
  overrides: [],
}

describe('RC2 Plugin Manager repository', () => {
  it('uses the pinned list Remotes and projects bundles/plugins without remote metadata diagnostics', async () => {
    const fixture = repository({
      'pluginManager/listBundles': { ok: true, value: [bundle] },
      'pluginManager/listPlugins': {
        ok: true,
        value: [
          {
            entryId: 'review:entry',
            moduleName: '@dsh-community/review-layer/review',
            enabled: true,
            fiberPhase: 'active',
            readOnlyReason: undefined,
          },
        ],
      },
    })
    await expect(fixture.repository.listBundles()).resolves.toEqual([
      {
        name: bundle.name,
        version: '1.2.0',
        title: { en: 'Review layer', zh: '审查层' },
        enabled: false,
        installed: false,
        optional: true,
        removable: false,
        rows: [
          { rowId: 'review', moduleName: '@dsh-community/review-layer/review', entryId: 'review:entry' },
        ],
        overrides: [],
      },
    ])
    await expect(fixture.repository.listPlugins()).resolves.toEqual([
      {
        entryId: 'review:entry',
        moduleName: '@dsh-community/review-layer/review',
        enabled: true,
        fiberPhase: 'active',
      },
    ])
    expect(fixture.calls.map((call) => call.endpoint)).toEqual([
      'pluginManager/listBundles',
      'pluginManager/listPlugins',
    ])
  })

  it('reads the dynamic registry order and safely projects package inspection refusals', async () => {
    const fixture = repository({
      'pluginManager/registries': {
        ok: true,
        value: {
          registry: 'https://registry.example.test/',
          fallbackRegistries: ['https://mirror.example.test/'],
          resolved: 'https://registry.example.test/',
        },
      },
      'pluginManager/inspect': {
        ok: true,
        value: {
          status: 'refused',
          problem: 'network',
          reason: 'private endpoint/path token=secret',
          registries: ['https://registry.example.test/'],
        },
      },
    })
    await expect(fixture.repository.registries()).resolves.toEqual({
      registry: 'https://registry.example.test/',
      fallbackRegistries: ['https://mirror.example.test/'],
      resolved: 'https://registry.example.test/',
    })
    await expect(
      fixture.repository.inspect('@dsh-community/missing', 'https://mirror.example.test/'),
    ).resolves.toEqual({
      status: 'refused',
      problem: 'network',
      registries: ['https://registry.example.test/'],
    })
    expect(fixture.calls[1]).toEqual({
      endpoint: 'pluginManager/inspect',
      args: { spec: '@dsh-community/missing', options: { registry: 'https://mirror.example.test/' } },
      signal: undefined,
    })
  })

  it('accepts DSH-supported SSH Git specs while still rejecting embedded passwords', async () => {
    const fixture = repository({
      'pluginManager/inspect': {
        ok: true,
        value: { status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' },
      },
    })
    await expect(fixture.repository.inspect('git+ssh://git@github.com/a/b.git')).resolves.toEqual({
      status: 'accepted',
      kind: 'git',
      bundle: null,
      registry: null,
      host: 'github.com',
    })
    expect(fixture.calls).toEqual([
      { endpoint: 'pluginManager/inspect', args: { spec: 'git+ssh://git@github.com/a/b.git' } },
    ])

    const invalid = repository({})
    await expect(invalid.repository.inspect('git+ssh://git:secret@github.com/a/b.git')).rejects.toMatchObject(
      { code: 'INVALID_CONFIGURATION' },
    )
    await expect(invalid.repository.inspect('git://user:secret@example.test/a/b.git')).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    expect(invalid.calls).toEqual([])
  })

  it('maps install outcomes without returning package output, paths, or original install specs', async () => {
    const spec = 'https://git.example.test/private/repo.git'
    const fixture = repository({
      'pluginManager/installBundle': {
        ok: true,
        value: {
          stage: 'install',
          target: spec,
          changed: false,
          application: 'failed',
          enabled: true,
          error: { code: 'operation-error', diagnostic: 'C:\\Users\\private\\profile\nBearer secret' },
          packageResult: {
            exitCode: 1,
            output: 'https://registry.example.test/auth=secret',
            truncated: false,
            logPath: 'C:\\Users\\private\\pnpm.log',
            kind: 'permission',
          },
          failedAt: 'registry',
        },
      },
    })
    await expect(
      fixture.repository.installBundle(spec, { requestId: 'install-1', registry: null }),
    ).resolves.toEqual({
      name: 'plugin',
      changed: false,
      application: 'failed',
      enabled: true,
      stage: 'install',
      errorCode: 'operation-error',
      failureKind: 'permission',
      failedAt: 'registry',
    })
    expect(fixture.calls[0]).toEqual({
      endpoint: 'pluginManager/installBundle',
      args: { spec, options: { enabled: true, requestId: 'install-1', registry: null } },
    })
  })

  it('maps the upstream install completion after it changes stage and target for activation', async () => {
    const bundleName = '@dsh-community/review-layer'
    const spec = 'git+https://example.test/review-layer.git'
    const fixture = repository({
      'pluginManager/installBundle': {
        ok: true,
        value: {
          stage: 'enable',
          target: bundleName,
          bundle: bundleName,
          changed: true,
          application: 'applied',
          enabled: true,
        },
      },
    })
    await expect(fixture.repository.installBundle(spec, { requestId: 'install-success' })).resolves.toEqual({
      name: bundleName,
      changed: true,
      application: 'applied',
      enabled: true,
      stage: 'install',
      bundle: bundleName,
    })
    expect(fixture.calls).toEqual([
      {
        endpoint: 'pluginManager/installBundle',
        args: { spec, options: { enabled: true, requestId: 'install-success' } },
      },
    ])
  })

  it('maps a confirmed upstream install cancellation and rejects target mismatches', async () => {
    const spec = 'review-layer'
    const cancelled = repository({
      'pluginManager/installBundle': {
        ok: true,
        value: { stage: 'install', target: spec, changed: false, application: 'cancelled', enabled: true },
      },
    })
    await expect(
      cancelled.repository.installBundle(spec, { requestId: 'install-cancelled' }),
    ).resolves.toMatchObject({ name: 'plugin', stage: 'install', application: 'cancelled', enabled: true })

    const mismatched = repository({
      'pluginManager/installBundle': {
        ok: true,
        value: { stage: 'install', target: 'other', changed: false, application: 'cancelled', enabled: true },
      },
    })
    await expect(
      mismatched.repository.installBundle(spec, { requestId: 'install-mismatch' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })

    const mismatchedBundle = repository({
      'pluginManager/installBundle': {
        ok: true,
        value: {
          stage: 'enable',
          target: '@dsh-community/other',
          bundle: '@dsh-community/review-layer',
          changed: true,
          application: 'applied',
          enabled: true,
        },
      },
    })
    await expect(
      mismatchedBundle.repository.installBundle(spec, { requestId: 'install-bundle-mismatch' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  })

  it('routes request-scoped cancellation, removal, and individual plugin enablement to RC2 Remotes', async () => {
    const fixture = repository({
      'pluginManager/cancelInstall': { ok: true, value: { status: 'too-late' } },
      'pluginManager/removeBundle': {
        ok: true,
        value: { target: bundle.name, stage: 'remove', changed: true, application: 'applied' },
      },
      'pluginManager/setPluginEnabled': {
        ok: true,
        value: {
          target: 'review:entry',
          stage: 'enable',
          changed: true,
          application: 'applied',
          enabled: false,
        },
      },
    })
    await expect(fixture.repository.cancelInstall('install-2')).resolves.toEqual({ status: 'too-late' })
    await expect(fixture.repository.removeBundle(bundle.name)).resolves.toMatchObject({
      stage: 'remove',
      changed: true,
    })
    await expect(fixture.repository.setPluginEnabled('review:entry', false)).resolves.toMatchObject({
      enabled: false,
    })
    expect(fixture.calls).toEqual([
      { endpoint: 'pluginManager/cancelInstall', args: { requestId: 'install-2' } },
      { endpoint: 'pluginManager/removeBundle', args: { name: bundle.name } },
      { endpoint: 'pluginManager/setPluginEnabled', args: { id: 'review:entry', enabled: false } },
    ])
  })

  it('rejects malformed and credential-bearing registry or install data before RPC', async () => {
    const fixture = repository({})
    await expect(fixture.repository.registries()).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
    await expect(
      fixture.repository.inspect('pkg', 'https://user:secret@registry.example.test/'),
    ).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
    })
    await expect(
      fixture.repository.installBundle('https://git.example.test/repo?token=secret', {
        requestId: 'install-3',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
    expect(fixture.calls).toEqual([{ endpoint: 'pluginManager/registries', args: {}, signal: undefined }])
  })
})
