import { describe, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { PluginInstallRecoveryController } from './plugin-install-recovery.js'

const installResult = {
  name: '@dsh-community/review',
  changed: true,
  application: 'applied',
  stage: 'install',
  bundle: '@dsh-community/review',
  version: '1.2.3',
} as const

function reply(result: unknown): unknown {
  return { kind: 'plugin.install.waited', result }
}

describe('PluginInstallRecoveryController', () => {
  it('keeps the original id after a lost reply, coalesces recovery, and never installs twice', async () => {
    const requests: FeatureRequest[] = []
    let finishWait!: (value: unknown) => void
    let waitCount = 0
    let refreshCount = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') throw new Error('reply lost')
        if (request.type === 'plugin.bundle.waitForInstall') {
          waitCount += 1
          if (waitCount === 1)
            return new Promise<T>((resolve) => {
              finishWait = resolve as (value: unknown) => void
            })
          return reply(installResult) as T
        }
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-recovery-${++next}`
      })(),
      onStateChange: (_state, refresh) => {
        if (refresh) refreshCount += 1
      },
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    await vi.waitFor(() => expect(waitCount).toBe(1))
    const installRequest = requests.find((request) => request.type === 'plugin.bundle.install')
    if (installRequest?.type !== 'plugin.bundle.install') throw new Error('install request missing')
    const installId = installRequest.payload.installRequestId
    expect(controller.state).toMatchObject({ requestId: installId, phase: 'unknown', waiting: true })

    const recovery = controller.recover()
    expect(waitCount).toBe(1)
    finishWait(reply(null))
    await Promise.all([installing, recovery])
    expect(controller.state).toMatchObject({ requestId: installId, phase: 'unknown', waiting: false })
    expect(refreshCount).toBe(1)

    await controller.recover()
    expect(controller.state).toMatchObject({ requestId: installId, phase: 'settled', result: installResult })
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toHaveLength(2)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
  })

  it('treats a failed wait as unknown, keeps the id, refreshes the catalog, and permits explicit recheck', async () => {
    const requests: FeatureRequest[] = []
    let refreshCount = 0
    let waitCount = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') return Promise.reject(new Error('reply lost'))
        if (request.type === 'plugin.bundle.waitForInstall') {
          waitCount += 1
          if (waitCount === 1) return Promise.reject(new Error('transport lost'))
          return Promise.resolve(reply(null) as T)
        }
        return Promise.reject(new Error(`Unexpected request ${request.type}`))
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-failed-wait-${++next}`
      })(),
      onStateChange: (_state, refresh) => {
        if (refresh) refreshCount += 1
      },
    })

    await controller.start({ spec: '@dsh-community/review' })
    const installId = requests.find((request) => request.type === 'plugin.bundle.install')
    if (installId?.type !== 'plugin.bundle.install') throw new Error('install request missing')
    expect(controller.state).toMatchObject({
      requestId: installId.payload.installRequestId,
      phase: 'unknown',
    })
    await controller.recover()
    expect(controller.state).toMatchObject({
      requestId: installId.payload.installRequestId,
      phase: 'unknown',
    })
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(waitCount).toBe(2)
    expect(refreshCount).toBe(2)
  })

  it('settles a known preflight failure without waiting and permits a fresh install', async () => {
    const requests: FeatureRequest[] = []
    let installCount = 0
    let refreshCount = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') {
          installCount += 1
          if (installCount === 1)
            throw Object.assign(new Error('The host rejected preflight.'), {
              code: 'PLUGIN_INSTALL_NOT_STARTED',
              retryable: true,
            })
          return Promise.resolve({ kind: 'plugin.bundle.changed', result: installResult } as T)
        }
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-preflight-${++next}`
      })(),
      onStateChange: (_state, refresh) => {
        if (refresh) refreshCount += 1
      },
    })

    await controller.start({ spec: '@dsh-community/review' })
    const firstInstall = requests.find((request) => request.type === 'plugin.bundle.install')
    if (firstInstall?.type !== 'plugin.bundle.install') throw new Error('first install request missing')
    expect(controller.state).toMatchObject({
      requestId: firstInstall.payload.installRequestId,
      phase: 'settled',
      waiting: false,
      result: {
        name: 'plugin',
        changed: false,
        application: 'failed',
        stage: 'install',
        errorCode: 'operation-error',
      },
    })
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toHaveLength(0)
    expect(refreshCount).toBe(1)

    await controller.start({ spec: '@dsh-community/review' })
    const installIds = requests
      .filter((request) => request.type === 'plugin.bundle.install')
      .map((request) => (request.type === 'plugin.bundle.install' ? request.payload.installRequestId : ''))
    expect(installIds).toHaveLength(2)
    expect(installIds[1]).not.toBe(installIds[0])
    expect(controller.state).toMatchObject({ phase: 'settled', result: installResult })
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toHaveLength(0)
    expect(refreshCount).toBe(2)
  })
})
