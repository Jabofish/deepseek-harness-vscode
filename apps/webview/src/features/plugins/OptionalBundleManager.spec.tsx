// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  rows: [
    { rowId: 'review', moduleName: '@dsh-community/review-layer/review', entryId: 'review:entry' },
    {
      rowId: 'help',
      moduleName: '@dsh-community/review-layer/help',
      entryId: 'help:entry',
      meta: { title: { en: 'Help plugin' }, description: { en: 'Creates release notes.' } },
    },
  ],
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

const helpPlugin = {
  entryId: 'help:entry',
  moduleName: '@dsh-community/review-layer/help',
  meta: { title: { en: 'Help plugin' }, description: { en: 'Creates release notes.' } },
  enabled: false,
  fiberPhase: null,
} as const

const snapshot = {
  available: true,
  bundles: [bundle],
  plugins: [plugin, helpPlugin, standalonePlugin],
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
  it('inspects a package against the chosen registry before enabling installation', async () => {
    const { requests } = mountManager()
    await screen.findByRole('heading', { name: 'DSH Plugin Manager' })
    fireEvent.change(screen.getByLabelText('Package name or supported package source'), {
      target: { value: '@dsh-community/new-plugin' },
    })
    fireEvent.click(screen.getByLabelText('Package registry'))
    fireEvent.click(screen.getByRole('option', { name: 'mirror.example.test' }))
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
})
