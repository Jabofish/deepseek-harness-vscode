// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { OptionalBundleManager, type OptionalBundleManagerProps } from './OptionalBundleManager.js'

afterEach(cleanup)

const optionalProvided = {
  name: '@dsh-community/review-layer',
  title: { en: 'Review layer', zh: '审查层' },
  description: { en: 'Reviews a proposed change.' },
  enabled: false,
  installed: false,
  hasIssue: false,
} as const

interface MountedManager {
  readonly requests: FeatureRequest[]
  readonly render: ReturnType<typeof render>
}

function mountManager(resolve: (request: FeatureRequest) => unknown = defaultResponse): MountedManager {
  const requests: FeatureRequest[] = []
  const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
    requests.push(request)
    return Promise.resolve().then(() => resolve(request) as T)
  }
  return {
    requests,
    render: render(<OptionalBundleManager featureRequest={featureRequest} />),
  }
}

function defaultResponse(request: FeatureRequest): unknown {
  if (request.type === 'plugin.bundles.list')
    return { kind: 'plugin.bundles', available: true, bundles: [optionalProvided] }
  if (request.type === 'plugin.bundle.setEnabled')
    return {
      kind: 'plugin.bundle.changed',
      result: {
        name: request.payload.name,
        changed: true,
        application: 'applied',
        enabled: request.payload.enabled,
      },
    }
  throw new Error(`Unexpected feature request: ${request.type}`)
}

describe('OptionalBundleManager', () => {
  it('renders the dynamic optional catalog, including a DSH-provided bundle', async () => {
    const { requests } = mountManager()
    expect(await screen.findByRole('heading', { name: 'Optional DSH bundles' })).toBeTruthy()
    expect(screen.getByText('Review layer')).toBeTruthy()
    expect(screen.getByText('Provided by the DSH installation')).toBeTruthy()
    expect(requests[0]).toMatchObject({ type: 'plugin.bundles.list', payload: {} })
  })

  it('rereads the dynamic catalog after the shared Plugin Manager event revision changes', async () => {
    const requests: FeatureRequest[] = []
    const featureRequest: OptionalBundleManagerProps['featureRequest'] = <T,>(request: FeatureRequest) => {
      requests.push(request)
      return Promise.resolve({ kind: 'plugin.bundles', available: true, bundles: [optionalProvided] } as T)
    }
    const view = render(<OptionalBundleManager revision={0} featureRequest={featureRequest} />)
    await screen.findByRole('heading', { name: 'Optional DSH bundles' })
    await waitFor(() => expect(requests).toHaveLength(1))

    view.rerender(<OptionalBundleManager revision={1} featureRequest={featureRequest} />)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests.map((request) => request.type)).toEqual(['plugin.bundles.list', 'plugin.bundles.list'])
  })

  it('shows profile scope before action and displays restart-required status after enable intent', async () => {
    let selected = false
    const { requests } = mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return {
          kind: 'plugin.bundles',
          available: true,
          bundles: [{ ...optionalProvided, enabled: selected }],
        }
      if (request.type === 'plugin.bundle.setEnabled') {
        selected = request.payload.enabled
        return {
          kind: 'plugin.bundle.changed',
          result: {
            name: request.payload.name,
            changed: true,
            application: 'restart-required',
            enabled: selected,
          },
        }
      }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })

    const enable = await screen.findByRole('button', { name: 'Enable Review layer' })
    expect(screen.getByText('A change affects every session that uses this DSH profile.')).toBeTruthy()
    expect(screen.getByText('Some changes take effect only after DSH restarts.')).toBeTruthy()
    fireEvent.click(enable)
    expect(requests.filter((request) => request.type === 'plugin.bundle.setEnabled')).toHaveLength(1)
    expect(await screen.findByText('The change was saved. Restart DSH to apply it.')).toBeTruthy()
    expect(requests.filter((request) => request.type === 'plugin.bundle.setEnabled')).toEqual([
      expect.objectContaining({
        type: 'plugin.bundle.setEnabled',
        payload: { name: '@dsh-community/review-layer', enabled: true },
      }),
    ])
    await waitFor(() =>
      expect(requests.filter((request) => request.type === 'plugin.bundles.list')).toHaveLength(2),
    )
    expect(screen.getByText('Selected')).toBeTruthy()
  })

  it('keeps a Host-declined enable action visibly cancelled', async () => {
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: true, bundles: [optionalProvided] }
      if (request.type === 'plugin.bundle.setEnabled')
        return {
          kind: 'plugin.bundle.changed',
          result: {
            name: request.payload.name,
            changed: false,
            application: 'cancelled',
            enabled: request.payload.enabled,
          },
        }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Enable Review layer' }))
    expect(await screen.findByText('The bundle change was cancelled.')).toBeTruthy()
  })

  it('does not treat a mutation result without the requested enabled state as success', async () => {
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: true, bundles: [optionalProvided] }
      if (request.type === 'plugin.bundle.setEnabled')
        return {
          kind: 'plugin.bundle.changed',
          result: {
            name: request.payload.name,
            changed: true,
            application: 'applied',
          },
        }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Enable Review layer' }))
    expect(
      await screen.findByText('The result could not be confirmed. The bundle list was refreshed.'),
    ).toBeTruthy()
  })

  it('keeps the result visible for application failures and handles missing manager and empty catalogs', async () => {
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: true, bundles: [optionalProvided] }
      if (request.type === 'plugin.bundle.setEnabled')
        return {
          kind: 'plugin.bundle.changed',
          result: {
            name: request.payload.name,
            changed: false,
            application: 'failed',
            enabled: request.payload.enabled,
            errorCode: 'incompatible-version',
          },
        }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Enable Review layer' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'DSH refused this bundle because it is incompatible with the running version.',
    )

    cleanup()
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: false, bundles: [] }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })
    expect(
      await screen.findByText('Optional bundle controls are unavailable in this DSH profile.'),
    ).toBeTruthy()

    cleanup()
    mountManager((request) => {
      if (request.type === 'plugin.bundles.list')
        return { kind: 'plugin.bundles', available: true, bundles: [] }
      throw new Error(`Unexpected feature request: ${request.type}`)
    })
    expect(await screen.findByText('This DSH installation offers no optional bundles.')).toBeTruthy()
  })

  it('retains issue/read-only facts and leaves a failed refresh recoverable', async () => {
    let attempts = 0
    mountManager((request) => {
      if (request.type !== 'plugin.bundles.list')
        throw new Error(`Unexpected feature request: ${request.type}`)
      attempts += 1
      if (attempts === 1) throw new Error('temporary failure')
      return {
        kind: 'plugin.bundles',
        available: true,
        bundles: [{ ...optionalProvided, hasIssue: true, readOnlyReason: 'management-required' }],
      }
    })
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The optional bundle list could not be loaded.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByText('DSH reports an issue with this bundle; enabling it may fail.'),
    ).toBeTruthy()
    expect(screen.getByText('DSH protects this bundle from profile changes.')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Enable Review layer' }).getAttribute('disabled'),
    ).not.toBeNull()
  })
})
