// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useMemo, useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import {
  PluginInstallRecoveryController,
  type PluginInstallRecoveryState,
} from '../../app/plugin-install-recovery.js'
import { OptionalBundleManager, type OptionalBundleManagerProps } from './OptionalBundleManager.js'

afterEach(cleanup)

const bundle = {
  name: '@dsh-community/review-layer',
  title: { en: 'Review layer', zh: '审查层' },
  description: { en: 'Reviews a proposed change.' },
  enabled: false,
  installed: true,
  optional: true,
  removable: true,
  rows: [{ rowId: 'review', moduleName: '@dsh-community/review-layer/review', entryId: 'review:entry' }],
  overrides: [],
} as const

const plugin = {
  entryId: 'review:entry',
  moduleName: '@dsh-community/review-layer/review',
  meta: { title: { en: 'Review plugin' } },
  enabled: true,
  fiberPhase: 'active',
} as const

const standalonePlugin = {
  entryId: 'standalone:entry',
  moduleName: '@dsh-community/standalone',
  meta: { title: { en: 'Standalone plugin' } },
  enabled: true,
  fiberPhase: null,
} as const

const snapshot = {
  available: true,
  bundles: [bundle],
  plugins: [plugin, standalonePlugin],
} as const

const registries = {
  registry: 'https://registry.example.test/',
  fallbackRegistries: ['https://mirror.example.test/'],
  resolved: 'https://registry.example.test/',
} as const

interface MountedManager {
  readonly requests: FeatureRequest[]
  readonly render: ReturnType<typeof render>
}

function ManagerHarness(props: {
  readonly featureRequest: OptionalBundleManagerProps['featureRequest']
  readonly revision?: number
  readonly installProgress?: OptionalBundleManagerProps['installProgress']
}): ReactElement {
  const [installOperation, setInstallOperation] = useState<PluginInstallRecoveryState>()
  const controller = useMemo(() => {
    let id = 0
    return new PluginInstallRecoveryController({
      featureRequest: props.featureRequest,
      requestId: () => `plugin-test-request-${++id}`,
      onStateChange: setInstallOperation,
    })
  }, [props.featureRequest])
  return (
    <OptionalBundleManager
      {...(props.revision === undefined ? {} : { revision: props.revision })}
      {...(props.installProgress === undefined ? {} : { installProgress: props.installProgress })}
      {...(installOperation === undefined ? {} : { installOperation })}
      onStartInstall={(input) => controller.start(input)}
      onCancelInstall={() => controller.cancel()}
      onRecoverInstall={() => controller.recover()}
      featureRequest={props.featureRequest}
    />
  )
}

function openSection(): void {
  const toggle = screen.getByRole('button', { name: 'DSH Plugin Manager' })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
}

function mountManager(resolve: (request: FeatureRequest) => unknown = defaultResponse): MountedManager {
  const requests: FeatureRequest[] = []
  const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
    requests.push(request)
    return Promise.resolve().then(() => resolve(request) as T)
  }
  const mounted = render(<ManagerHarness featureRequest={featureRequest} />)
  // The manager panel collapses by default, so a test that touches its body opens it first.
  openSection()
  return { requests, render: mounted }
}

function defaultResponse(request: FeatureRequest): unknown {
  if (request.type === 'plugin.bundles.list') return { kind: 'plugin.bundles', ...snapshot }
  if (request.type === 'plugin.registries.list')
    return { kind: 'plugin.registries', available: true, registries }
  if (request.type === 'plugin.spec.inspect')
    return {
      kind: 'plugin.inspection',
      inspection: {
        status: 'accepted',
        kind: 'registry',
        name: '@dsh-community/new-plugin',
        version: '2.0.0',
        description: 'A new DSH plugin bundle.',
        bundle: true,
        registry: 'https://mirror.example.test/',
      },
    }
  if (request.type === 'plugin.bundle.install')
    return {
      kind: 'plugin.bundle.changed',
      result: { name: 'new-plugin', changed: true, application: 'applied', stage: 'install' },
    }
  if (request.type === 'plugin.bundle.setEnabled')
    return {
      kind: 'plugin.bundle.changed',
      result: {
        name: request.payload.name,
        changed: true,
        application: 'restart-required',
        enabled: request.payload.enabled,
        stage: 'enable',
      },
    }
  if (request.type === 'plugin.entry.setEnabled')
    return {
      kind: 'plugin.bundle.changed',
      result: {
        name: request.payload.entryId,
        changed: true,
        application: 'applied',
        enabled: request.payload.enabled,
        stage: 'enable',
      },
    }
  if (request.type === 'plugin.bundle.remove')
    return {
      kind: 'plugin.bundle.changed',
      result: { name: request.payload.name, changed: true, application: 'applied', stage: 'remove' },
    }
  throw new Error(`Unexpected feature request: ${request.type}`)
}

describe('OptionalBundleManager', () => {
  it('renders live profile bundles, linked and standalone plugin entries, and DSH registry choices', async () => {
    const { requests } = mountManager()
    expect(await screen.findByRole('heading', { name: 'DSH Plugin Manager' })).toBeTruthy()
    expect(screen.getByText('Review layer')).toBeTruthy()
    // A bundle's own copy and the standalone list start collapsed; the actions stay reachable.
    expect(screen.queryByText('Reviews a proposed change.')).toBeNull()
    expect(screen.queryByText('Standalone plugin')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Review layer/u }))
    expect(screen.getByText('Reviews a proposed change.')).toBeTruthy()
    expect(screen.getByText('Review plugin')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /^Other plugin entries/u }))
    expect(screen.getByText('Standalone plugin')).toBeTruthy()
    expect(screen.getByLabelText('Package registry')).toBeTruthy()
    expect(requests.map((request) => request.type)).toEqual(['plugin.bundles.list', 'plugin.registries.list'])
  })

  it('rereads both live catalogs after the shared Plugin Manager revision changes', async () => {
    const requests: FeatureRequest[] = []
    const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
      requests.push(request)
      const response =
        request.type === 'plugin.bundles.list'
          ? { kind: 'plugin.bundles', ...snapshot }
          : { kind: 'plugin.registries', available: true, registries }
      return Promise.resolve(response as T)
    }
    const view = render(<ManagerHarness revision={0} featureRequest={featureRequest} />)
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    await waitFor(() => expect(requests).toHaveLength(2))

    view.rerender(<ManagerHarness revision={1} featureRequest={featureRequest} />)
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests.map((request) => request.type)).toEqual([
      'plugin.bundles.list',
      'plugin.registries.list',
      'plugin.bundles.list',
      'plugin.registries.list',
    ])
  })

  it('inspects a package against the chosen registry before enabling installation', async () => {
    const { requests } = mountManager()
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
      target: { value: '@dsh-community/new-plugin' },
    })
    fireEvent.click(screen.getByLabelText('Package registry'))
    fireEvent.click(screen.getByRole('option', { name: 'https://mirror.example.test/' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check package' }))
    expect(await screen.findByText('Package: @dsh-community/new-plugin · 2.0.0')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' }).getAttribute('disabled')).toBeNull()
    expect(requests.filter((request) => request.type === 'plugin.spec.inspect')).toEqual([
      expect.objectContaining({
        type: 'plugin.spec.inspect',
        payload: { spec: '@dsh-community/new-plugin', registry: 'https://mirror.example.test/' },
      }),
    ])
  })

  it('routes a confirmed install request and displays its safe outcome', async () => {
    const { requests } = mountManager()
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
      target: { value: '@dsh-community/new-plugin' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check package' }))
    await screen.findByText('Package: @dsh-community/new-plugin · 2.0.0')
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    expect(await screen.findByText('The plugin bundle was installed.')).toBeTruthy()
    const installRequest = requests.find((request) => request.type === 'plugin.bundle.install')
    if (installRequest?.type !== 'plugin.bundle.install') throw new Error('install request missing')
    expect(installRequest.payload.spec).toBe('@dsh-community/new-plugin')
    expect(installRequest.payload.installRequestId).toEqual(expect.any(String))
    expect(installRequest.payload.registry).toBe('https://registry.example.test/')
  })

  it('keeps an unknown install recoverable across manager unmount without starting another install', async () => {
    const requests: FeatureRequest[] = []
    const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
      requests.push(request)
      return Promise.resolve(defaultResponse(request) as T)
    }
    const installOperation: PluginInstallRecoveryState = {
      requestId: 'private-install-request-id',
      phase: 'unknown',
      cancelRequested: false,
      waiting: false,
    }
    const onRecoverInstall = vi.fn().mockResolvedValue(undefined)
    const props = {
      featureRequest,
      installOperation,
      onRecoverInstall,
    } satisfies OptionalBundleManagerProps

    const first = render(<OptionalBundleManager {...props} />)
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    expect(
      screen.getByText(
        'The install result is still unknown. Check its status before starting another install.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(installOperation.requestId)).toBeNull()
    first.unmount()

    render(<OptionalBundleManager {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check install status' }))
    expect(onRecoverInstall).toHaveBeenCalledOnce()
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(0)
  })

  it.each(['too-late', 'cancelled'] as const)(
    'offers cancellation during a lost-reply recovery wait and handles the %s result',
    async (status) => {
      const requests: FeatureRequest[] = []
      let finishWait!: (value: unknown) => void
      let finishCancel!: (value: unknown) => void
      let waitCount = 0
      const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') return Promise.reject(new Error('reply lost'))
        if (request.type === 'plugin.bundle.waitForInstall') {
          waitCount += 1
          return new Promise<T>((resolve) => {
            finishWait = resolve as (value: unknown) => void
          })
        }
        if (request.type === 'plugin.bundle.cancelInstall')
          return new Promise<T>((resolve) => {
            finishCancel = resolve as (value: unknown) => void
          })
        return Promise.resolve(defaultResponse(request) as T)
      }
      const view = render(<ManagerHarness featureRequest={featureRequest} />)
      await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
      openSection()
      fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
        target: { value: '@dsh-community/new-plugin' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Check package' }))
      await screen.findByText('Package: @dsh-community/new-plugin · 2.0.0')
      fireEvent.click(screen.getByRole('button', { name: 'Install' }))

      const cancel = await screen.findByRole('button', { name: 'Cancel install' })
      expect(cancel.getAttribute('disabled')).toBeNull()
      expect(waitCount).toBe(1)
      const installRequest = requests.find((request) => request.type === 'plugin.bundle.install')
      if (installRequest?.type !== 'plugin.bundle.install') throw new Error('install request missing')
      const installId = installRequest.payload.installRequestId

      fireEvent.click(cancel)
      const cancelRequest = await waitFor(() => {
        const found = requests.find((request) => request.type === 'plugin.bundle.cancelInstall')
        if (found?.type !== 'plugin.bundle.cancelInstall') throw new Error('cancel request missing')
        return found
      })
      expect(cancelRequest.payload.installRequestId).toBe(installId)
      const cancellationPending = await screen.findByRole('button', {
        name: 'Waiting for DSH to stop and restore the profile…',
      })
      expect(cancellationPending.getAttribute('disabled')).not.toBeNull()
      await act(async () => {
        finishCancel({ kind: 'plugin.install.cancelled', status })
        await Promise.resolve()
      })

      if (status === 'too-late') {
        const applying = await screen.findByRole('button', {
          name: 'Applying plugin changes to the DSH profile…',
        })
        expect(applying.getAttribute('disabled')).not.toBeNull()
        await act(async () => {
          finishWait({
            kind: 'plugin.install.waited',
            result: {
              name: 'new-plugin',
              changed: true,
              application: 'applied',
              stage: 'install',
            },
          })
          await Promise.resolve()
        })
        expect(await screen.findByText('The plugin bundle was installed.')).toBeTruthy()
      } else {
        expect(await screen.findByText('The bundle change was cancelled.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Cancel install' })).toBeNull()
        await act(async () => {
          finishWait({ kind: 'plugin.install.waited', result: null })
          await Promise.resolve()
        })
        expect(screen.getByText('The bundle change was cancelled.')).toBeTruthy()
      }

      expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
      expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
        expect.objectContaining({ payload: { installRequestId: installId } }),
      ])
      expect(requests.filter((request) => request.type === 'plugin.bundle.cancelInstall')).toEqual([
        expect.objectContaining({ payload: { installRequestId: installId } }),
      ])
      view.unmount()
    },
  )

  it('offers cancellation again when installing progress follows a not-running recovery', async () => {
    const requests: FeatureRequest[] = []
    const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
      requests.push(request)
      return Promise.resolve(defaultResponse(request) as T)
    }
    const installOperation: PluginInstallRecoveryState = {
      requestId: 'retryable-install-id',
      phase: 'unknown',
      cancelRequested: false,
      waiting: false,
      cancellation: 'not-running',
    }
    const onCancelInstall = vi.fn().mockResolvedValue(undefined)
    const props = {
      featureRequest,
      installOperation,
      onCancelInstall,
    } satisfies OptionalBundleManagerProps
    const view = render(<OptionalBundleManager {...props} />)
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    expect(screen.queryByRole('button', { name: 'Cancel install' })).toBeNull()

    view.rerender(
      <OptionalBundleManager
        {...props}
        installOperation={{ ...installOperation, phase: 'installing' }}
        installProgress={{ requestId: installOperation.requestId, phase: 'installing' }}
      />,
    )
    const cancel = await screen.findByRole('button', { name: 'Cancel install' })
    expect(cancel.getAttribute('disabled')).toBeNull()
    fireEvent.click(cancel)
    expect(onCancelInstall).toHaveBeenCalledOnce()
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(0)
  })

  it('shows safe registry attempt and applying phases while the install request is active', async () => {
    const requests: FeatureRequest[] = []
    let finishInstall: (() => void) | undefined
    const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
      requests.push(request)
      if (request.type === 'plugin.bundle.install')
        return new Promise<T>((resolve) => {
          finishInstall = () =>
            resolve({
              kind: 'plugin.bundle.changed',
              result: { name: 'new-plugin', changed: true, application: 'applied', stage: 'install' },
            } as T)
        })
      return Promise.resolve(defaultResponse(request) as T)
    }
    const view = render(<ManagerHarness featureRequest={featureRequest} />)
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    openSection()
    fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
      target: { value: '@dsh-community/new-plugin' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check package' }))
    await screen.findByText('Package: @dsh-community/new-plugin · 2.0.0')
    fireEvent.click(screen.getByRole('button', { name: 'Install' }))
    await screen.findByText('Installing through DSH…')
    const installRequest = requests.find((request) => request.type === 'plugin.bundle.install')
    if (installRequest?.type !== 'plugin.bundle.install') throw new Error('install request missing')
    const installRequestId = installRequest.payload.installRequestId

    view.rerender(
      <ManagerHarness
        featureRequest={featureRequest}
        installProgress={{
          requestId: installRequestId,
          phase: 'installing',
          attemptIndex: 2,
          attemptTotal: 3,
        }}
      />,
    )
    expect(await screen.findByText('Checking package source 2 of 3…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel install' }).getAttribute('disabled')).toBeNull()

    view.rerender(
      <ManagerHarness
        featureRequest={featureRequest}
        installProgress={{ requestId: installRequestId, phase: 'applying' }}
      />,
    )
    expect((await screen.findAllByText('Applying plugin changes to the DSH profile…')).length).toBe(2)
    expect(
      screen
        .getByRole('button', { name: 'Applying plugin changes to the DSH profile…' })
        .getAttribute('disabled'),
    ).not.toBeNull()

    if (finishInstall === undefined) throw new Error('install completion missing')
    const completeInstall = finishInstall
    await act(async () => {
      completeInstall()
      await Promise.resolve()
    })
  })

  it('dispatches bundle and plugin entry changes, and removal for removable bundles', async () => {
    const { requests } = mountManager()
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Review layer' }))
    expect(await screen.findByText('Some changes take effect only after DSH restarts.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /^Other plugin entries/u }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disable Standalone plugin' }))
    await waitFor(() =>
      expect(requests.some((request) => request.type === 'plugin.entry.setEnabled')).toBe(true),
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Review layer' }))
    await waitFor(() =>
      expect(requests.some((request) => request.type === 'plugin.bundle.remove')).toBe(true),
    )
    expect(requests.filter((request) => request.type === 'plugin.bundle.setEnabled')).toEqual([
      expect.objectContaining({ payload: { name: bundle.name, enabled: true } }),
    ])
    expect(requests.filter((request) => request.type === 'plugin.entry.setEnabled')).toEqual([
      expect.objectContaining({ payload: { entryId: standalonePlugin.entryId, enabled: false } }),
    ])
    expect(requests.filter((request) => request.type === 'plugin.bundle.remove')).toEqual([
      expect.objectContaining({ payload: { name: bundle.name } }),
    ])
  })

  it('renders refused package inspection without exposing upstream diagnostics', async () => {
    mountManager((request) => {
      if (request.type === 'plugin.spec.inspect')
        return { kind: 'plugin.inspection', inspection: { status: 'refused', problem: 'not-a-bundle' } }
      return defaultResponse(request)
    })
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
      target: { value: 'not-a-plugin' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check package' }))
    expect(await screen.findByText('This package does not declare a DSH plugin bundle.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Install' }).getAttribute('disabled')).not.toBeNull()
  })

  it('keeps failed refresh recoverable and presents unavailable and empty catalogs', async () => {
    let attempts = 0
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list') {
        attempts += 1
        if (attempts === 1) throw new Error('temporary failure')
        return { kind: 'plugin.bundles', available: true, bundles: [], plugins: [] }
      }
      if (request.type === 'plugin.registries.list')
        return { kind: 'plugin.registries', available: false, registries: null }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The optional bundle list could not be loaded.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('This DSH profile has no plugin bundles.')).toBeTruthy()

    cleanup()
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: false, bundles: [], plugins: [] }
      if (request.type === 'plugin.registries.list')
        return { kind: 'plugin.registries', available: false, registries: null }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })
    expect(
      await screen.findByText('Optional bundle controls are unavailable in this DSH profile.'),
    ).toBeTruthy()
  })
})
