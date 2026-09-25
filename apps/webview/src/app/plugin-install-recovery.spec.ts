import { describe, expect, it, vi } from 'vitest'
import type { FeatureRequest } from '@dsh-vscode/webview-protocol'
import { PluginInstallRecoveryController } from './plugin-install-recovery.js'

const installResult = {
  name: '@dsh-community/review',
  changed: true,
  application: 'applied',
  stage: 'install',
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

  it('cancels the same install id while lost-reply recovery is waiting, then settles the recovered result after too-late', async () => {
    const requests: FeatureRequest[] = []
    let finishWait!: (value: unknown) => void
    let waitCount = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') throw new Error('reply lost')
        if (request.type === 'plugin.bundle.waitForInstall') {
          waitCount += 1
          return new Promise<T>((resolve) => {
            finishWait = resolve as (value: unknown) => void
          })
        }
        if (request.type === 'plugin.bundle.cancelInstall')
          return { kind: 'plugin.install.cancelled', status: 'too-late' } as T
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-recovery-cancel-${++next}`
      })(),
      onStateChange: () => undefined,
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    await vi.waitFor(() => expect(waitCount).toBe(1))
    const installRequest = requests.find((request) => request.type === 'plugin.bundle.install')
    if (installRequest?.type !== 'plugin.bundle.install') throw new Error('install request missing')
    const installId = installRequest.payload.installRequestId
    expect(controller.state).toMatchObject({ requestId: installId, phase: 'unknown', waiting: true })

    const cancelling = controller.cancel()
    await vi.waitFor(() =>
      expect(controller.state).toMatchObject({
        requestId: installId,
        phase: 'applying',
        cancellation: 'too-late',
        waiting: true,
      }),
    )
    finishWait(reply(installResult))
    await Promise.all([installing, cancelling])

    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'settled',
      cancellation: 'too-late',
      result: installResult,
      waiting: false,
    })
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
    expect(requests.filter((request) => request.type === 'plugin.bundle.cancelInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
  })

  it('keeps confirmed cancellation when the already-running recovery wait later returns unknown', async () => {
    const requests: FeatureRequest[] = []
    let finishWait!: (value: unknown) => void
    let waitCount = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install') throw new Error('reply lost')
        if (request.type === 'plugin.bundle.waitForInstall') {
          waitCount += 1
          return new Promise<T>((resolve) => {
            finishWait = resolve as (value: unknown) => void
          })
        }
        if (request.type === 'plugin.bundle.cancelInstall')
          return { kind: 'plugin.install.cancelled', status: 'cancelled' } as T
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-recovery-cancelled-${++next}`
      })(),
      onStateChange: () => undefined,
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    await vi.waitFor(() => expect(waitCount).toBe(1))
    const installId = controller.state?.requestId
    expect(controller.state).toMatchObject({ requestId: installId, phase: 'unknown', waiting: true })

    await controller.cancel()
    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'settled',
      cancellation: 'cancelled',
      waiting: false,
    })
    finishWait(reply(null))
    await installing

    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'settled',
      cancellation: 'cancelled',
      waiting: false,
    })
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
  })

  it.each(['not-running', 'too-late'] as const)(
    'does not let a late %s cancellation response overwrite the result from a newer wait response',
    async (status) => {
      const requests: FeatureRequest[] = []
      let finishWait!: (value: unknown) => void
      let finishCancel!: (value: unknown) => void
      let waitCount = 0
      const controller = new PluginInstallRecoveryController({
        featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
          requests.push(request)
          if (request.type === 'plugin.bundle.install') throw new Error('reply lost')
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
          throw new Error(`Unexpected request ${request.type}`)
        },
        requestId: (() => {
          let next = 0
          return () => `plugin-late-cancel-${++next}`
        })(),
        onStateChange: () => undefined,
      })

      const installing = controller.start({ spec: '@dsh-community/review' })
      await vi.waitFor(() => expect(waitCount).toBe(1))
      const installId = controller.state?.requestId
      const cancelling = controller.cancel()
      await vi.waitFor(() => expect(finishCancel).toBeTypeOf('function'))

      finishWait(reply(installResult))
      await installing
      expect(controller.state).toMatchObject({
        requestId: installId,
        phase: 'settled',
        result: installResult,
      })

      finishCancel({ kind: 'plugin.install.cancelled', status })
      await cancelling
      expect(controller.state).toMatchObject({
        requestId: installId,
        phase: 'settled',
        result: installResult,
      })
      expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
      expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
        expect.objectContaining({ payload: { installRequestId: installId } }),
      ])
      expect(requests.filter((request) => request.type === 'plugin.bundle.cancelInstall')).toEqual([
        expect.objectContaining({ payload: { installRequestId: installId } }),
      ])
    },
  )

  it('waits after cancel returns too-late and preserves the confirmed result', async () => {
    const requests: FeatureRequest[] = []
    let finishInstall!: (value: unknown) => void
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install')
          return new Promise<T>((resolve) => {
            finishInstall = resolve as (value: unknown) => void
          })
        if (request.type === 'plugin.bundle.cancelInstall')
          return { kind: 'plugin.install.cancelled', status: 'too-late' } as T
        if (request.type === 'plugin.bundle.waitForInstall') return reply(installResult) as T
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-cancel-${++next}`
      })(),
      onStateChange: () => undefined,
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    const installId = controller.state?.requestId
    await controller.cancel()
    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'settled',
      cancellation: 'too-late',
      result: installResult,
    })
    finishInstall({ kind: 'plugin.bundle.changed', result: installResult })
    await installing
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.cancelInstall')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
  })

  it('retries cancellation for the same id after not-running, a null wait, and new installing progress', async () => {
    const requests: FeatureRequest[] = []
    let finishInstall!: (value: unknown) => void
    let cancellations = 0
    let waits = 0
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install')
          return new Promise<T>((resolve) => {
            finishInstall = resolve as (value: unknown) => void
          })
        if (request.type === 'plugin.bundle.cancelInstall') {
          cancellations += 1
          return {
            kind: 'plugin.install.cancelled',
            status: cancellations === 1 ? 'not-running' : 'too-late',
          } as T
        }
        if (request.type === 'plugin.bundle.waitForInstall') {
          waits += 1
          return reply(waits === 1 ? null : installResult) as T
        }
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-cancel-retry-${++next}`
      })(),
      onStateChange: () => undefined,
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    const installId = controller.state?.requestId
    await controller.cancel()
    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'unknown',
      cancellation: 'not-running',
      cancelRequested: false,
      waiting: false,
    })

    controller.progress({ requestId: installId ?? '', phase: 'installing' })
    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'installing',
      cancelRequested: false,
      waiting: false,
    })
    await controller.cancel()
    expect(controller.state).toMatchObject({
      requestId: installId,
      phase: 'settled',
      cancellation: 'too-late',
      result: installResult,
    })
    finishInstall({ kind: 'plugin.bundle.changed', result: installResult })
    await installing

    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.cancelInstall')).toEqual([
      expect.objectContaining({ payload: { installRequestId: installId } }),
      expect.objectContaining({ payload: { installRequestId: installId } }),
    ])
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

  it('keeps an explicit not-running cancellation when the pending preflight later proves no install was sent', async () => {
    const requests: FeatureRequest[] = []
    let rejectInstall!: (error: unknown) => void
    const controller = new PluginInstallRecoveryController({
      featureRequest: async <T>(request: FeatureRequest): Promise<T> => {
        requests.push(request)
        if (request.type === 'plugin.bundle.install')
          return new Promise<T>((_resolve, reject) => {
            rejectInstall = reject
          })
        if (request.type === 'plugin.bundle.cancelInstall')
          return { kind: 'plugin.install.cancelled', status: 'not-running' } as T
        if (request.type === 'plugin.bundle.waitForInstall') return reply(null) as T
        throw new Error(`Unexpected request ${request.type}`)
      },
      requestId: (() => {
        let next = 0
        return () => `plugin-preflight-cancel-${++next}`
      })(),
      onStateChange: () => undefined,
    })

    const installing = controller.start({ spec: '@dsh-community/review' })
    await vi.waitFor(() => expect(rejectInstall).toBeTypeOf('function'))
    await controller.cancel()
    expect(controller.state).toMatchObject({
      phase: 'unknown',
      cancellation: 'not-running',
      waiting: false,
    })

    rejectInstall(
      Object.assign(new Error('registry lookup failed before install dispatch'), {
        code: 'PLUGIN_INSTALL_NOT_STARTED',
      }),
    )
    await installing

    expect(controller.state).toMatchObject({
      phase: 'settled',
      cancellation: 'cancelled',
      waiting: false,
    })
    expect(controller.state?.result).toBeUndefined()
    expect(requests.filter((request) => request.type === 'plugin.bundle.install')).toHaveLength(1)
    expect(requests.filter((request) => request.type === 'plugin.bundle.waitForInstall')).toHaveLength(1)
  })
})
