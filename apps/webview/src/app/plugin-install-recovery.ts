import type {
  PluginBundleChangeResult,
  PluginInstallCancellation,
  PluginInstallProgressView,
  PluginRegistry,
} from '@dsh-vscode/domain'
import { featureResponseSchema, type FeatureRequest } from '@dsh-vscode/webview-protocol'

export interface PluginInstallRecoveryState {
  readonly requestId: string
  readonly phase: 'installing' | 'cancelling' | 'applying' | 'unknown' | 'settled'
  readonly cancelRequested: boolean
  readonly waiting: boolean
  readonly cancellation?: PluginInstallCancellation['status']
  readonly result?: PluginBundleChangeResult
}

export interface PluginInstallInput {
  readonly spec: string
  readonly registry?: PluginRegistry
  readonly approvedBuilds?: readonly string[]
}

interface PluginInstallRecoveryDependencies {
  readonly featureRequest: <T>(request: FeatureRequest) => Promise<T>
  readonly requestId: () => string
  readonly onStateChange: (state: PluginInstallRecoveryState, refreshCatalog: boolean) => void
}

/** Keeps a lost install reply recoverable independently of the settings tab's component lifetime. */
export class PluginInstallRecoveryController {
  private current: PluginInstallRecoveryState | undefined
  private readonly waits = new Map<string, Promise<void>>()
  private disposed = false

  public constructor(private readonly dependencies: PluginInstallRecoveryDependencies) {}

  public get state(): PluginInstallRecoveryState | undefined {
    return this.current
  }

  public start(input: PluginInstallInput): Promise<void> {
    if (this.current !== undefined && this.current.phase !== 'settled') return Promise.resolve()
    const requestId = this.dependencies.requestId()
    if (!this.begin({ requestId, phase: 'installing', cancelRequested: false, waiting: false }, false))
      return Promise.resolve()
    return this.runInstall(requestId, input)
  }

  public cancel(): Promise<void> {
    const current = this.current
    if (
      current === undefined ||
      current.phase === 'settled' ||
      (current.phase === 'unknown' && !current.waiting) ||
      current.cancelRequested ||
      current.phase === 'applying' ||
      current.cancellation === 'cancelled' ||
      current.cancellation === 'too-late'
    )
      return Promise.resolve()

    if (!this.commitFor(current.requestId, { ...current, phase: 'cancelling', cancelRequested: true }, false))
      return Promise.resolve()
    return this.runCancel(current.requestId)
  }

  public recover(): Promise<void> {
    const requestId = this.current?.requestId
    return requestId === undefined ? Promise.resolve() : this.recoverRequest(requestId)
  }

  public progress(progress: PluginInstallProgressView): void {
    const current = this.current
    if (current === undefined || current.requestId !== progress.requestId || current.phase === 'settled')
      return
    const nextPhase = progress.phase === 'applying' ? 'applying' : progress.phase
    if (nextPhase === 'installing' && (current.phase === 'applying' || current.cancellation === 'too-late'))
      return
    const retryAfterNotRunning = nextPhase === 'installing' && current.cancellation === 'not-running'
    this.commitFor(
      current.requestId,
      {
        ...current,
        phase: nextPhase,
        cancelRequested: retryAfterNotRunning
          ? false
          : current.cancelRequested || progress.phase === 'cancelling',
        ...(nextPhase === 'installing' ? { waiting: false } : {}),
      },
      false,
    )
  }

  public dispose(): void {
    this.disposed = true
    this.waits.clear()
  }

  private async runInstall(requestId: string, input: PluginInstallInput): Promise<void> {
    try {
      const response = await this.dependencies.featureRequest<unknown>({
        type: 'plugin.bundle.install',
        requestId: this.dependencies.requestId(),
        payload: {
          spec: input.spec,
          installRequestId: requestId,
          ...(input.registry === undefined ? {} : { registry: input.registry }),
          ...(input.approvedBuilds === undefined ? {} : { approvedBuilds: [...input.approvedBuilds] }),
        },
      })
      const payload = validatedPayload(response)
      if (payload?.kind !== 'plugin.bundle.changed' || payload.result.stage !== 'install')
        throw new Error('The install result did not match the requested operation.')
      this.settled(requestId, toDomainChangeResult(payload.result))
    } catch (error) {
      const current = this.current
      if (
        current?.requestId !== requestId ||
        current.phase === 'settled' ||
        current.cancellation === 'cancelled'
      )
        return
      if (isPluginInstallNotStarted(error)) {
        if (
          current.cancelRequested ||
          current.phase === 'cancelling' ||
          current.cancellation === 'not-running'
        ) {
          this.settled(requestId, undefined, 'cancelled')
          return
        }
        this.settled(requestId, {
          name: 'plugin',
          changed: false,
          application: 'failed',
          stage: 'install',
          errorCode: 'operation-error',
        })
        return
      }
      this.commitFor(
        requestId,
        {
          ...current,
          phase: current.phase === 'installing' ? 'unknown' : current.phase,
          waiting: false,
        },
        false,
      )
      // A failed Webview reply does not cancel the Host request or prove failure.
      // Recover with the same DSH request id; this path never starts another install.
      await this.recoverRequest(requestId)
    }
  }

  private async runCancel(requestId: string): Promise<void> {
    try {
      const response = await this.dependencies.featureRequest<unknown>({
        type: 'plugin.bundle.cancelInstall',
        requestId: this.dependencies.requestId(),
        payload: { installRequestId: requestId },
      })
      const payload = validatedPayload(response)
      if (payload?.kind !== 'plugin.install.cancelled') throw new Error('Malformed cancellation result.')
      const current = this.currentFor(requestId)
      if (current.phase === 'settled') return
      if (payload.status === 'cancelled') {
        this.settled(requestId, undefined, 'cancelled', true)
        return
      }
      if (payload.status === 'too-late') {
        this.commitFor(
          requestId,
          { ...current, phase: 'applying', cancelRequested: false, cancellation: 'too-late' },
          false,
        )
      } else {
        this.commitFor(
          requestId,
          { ...current, phase: 'unknown', cancelRequested: false, cancellation: 'not-running' },
          false,
        )
      }
    } catch {
      const current = this.current
      if (current?.requestId !== requestId || current.phase === 'settled') return
      this.commitFor(
        requestId,
        {
          ...current,
          phase: current.phase === 'applying' ? 'applying' : 'unknown',
          cancelRequested: false,
        },
        false,
      )
    }
    await this.recoverRequest(requestId)
  }

  private recoverRequest(requestId: string): Promise<void> {
    const current = this.current
    if (current === undefined || current.requestId !== requestId || current.phase === 'settled')
      return Promise.resolve()
    const existing = this.waits.get(requestId)
    if (existing !== undefined) return existing

    if (!this.commitFor(requestId, { ...current, waiting: true }, false)) return Promise.resolve()
    const pending = this.runWait(requestId)
    this.waits.set(requestId, pending)
    return pending.finally(() => {
      if (this.waits.get(requestId) === pending) this.waits.delete(requestId)
    })
  }

  private async runWait(requestId: string): Promise<void> {
    try {
      const response = await this.dependencies.featureRequest<unknown>({
        type: 'plugin.bundle.waitForInstall',
        requestId: this.dependencies.requestId(),
        payload: { installRequestId: requestId },
      })
      const payload = validatedPayload(response)
      if (payload?.kind !== 'plugin.install.waited') throw new Error('Malformed install recovery result.')
      if (payload.result === null) {
        this.unknown(requestId)
        return
      }
      this.settled(requestId, toDomainChangeResult(payload.result))
    } catch {
      this.unknown(requestId)
    }
  }

  private unknown(requestId: string): void {
    const current = this.current
    if (current === undefined || current.requestId !== requestId || current.phase === 'settled') return
    const cancellationInFlight = current.phase === 'cancelling' && current.cancelRequested
    const tooLate = current.phase === 'applying' || current.cancellation === 'too-late'
    this.commitFor(
      requestId,
      {
        ...current,
        ...(!cancellationInFlight && !tooLate ? { phase: 'unknown', cancelRequested: false } : {}),
        waiting: false,
      },
      true,
    )
  }

  private settled(
    requestId: string,
    result: PluginBundleChangeResult | undefined,
    cancellation?: PluginInstallCancellation['status'],
    refreshCatalog = true,
  ): void {
    const current = this.current
    if (current === undefined || current.requestId !== requestId || current.phase === 'settled') return
    this.commitFor(
      requestId,
      {
        ...current,
        phase: 'settled',
        waiting: false,
        ...(result === undefined ? {} : { result }),
        ...(cancellation === undefined ? {} : { cancellation }),
      },
      refreshCatalog,
    )
  }

  private currentFor(requestId: string): PluginInstallRecoveryState {
    const current = this.current
    if (current === undefined || current.requestId !== requestId)
      throw new Error('The active install request changed before its response.')
    return current
  }

  private begin(state: PluginInstallRecoveryState, refreshCatalog: boolean): boolean {
    const current = this.current
    if (
      this.disposed ||
      (current !== undefined && current.phase !== 'settled') ||
      current?.requestId === state.requestId
    )
      return false
    this.current = state
    this.dependencies.onStateChange(state, refreshCatalog)
    return true
  }

  private commitFor(requestId: string, state: PluginInstallRecoveryState, refreshCatalog: boolean): boolean {
    const current = this.current
    if (
      this.disposed ||
      current?.requestId !== requestId ||
      current.phase === 'settled' ||
      state.requestId !== requestId
    )
      return false
    this.current = state
    this.dependencies.onStateChange(state, refreshCatalog)
    return true
  }
}

type SuccessfulFeatureResponse = Extract<
  ReturnType<typeof featureResponseSchema.parse>,
  { readonly ok: true }
>
type PluginBundleChangedPayload = Extract<
  SuccessfulFeatureResponse['payload'],
  { readonly kind: 'plugin.bundle.changed' }
>

function toDomainChangeResult(result: PluginBundleChangedPayload['result']): PluginBundleChangeResult {
  return {
    name: result.name,
    changed: result.changed,
    application: result.application,
    ...(result.enabled === undefined ? {} : { enabled: result.enabled }),
    ...(result.stage === undefined ? {} : { stage: result.stage }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
    ...(result.failedAt === undefined ? {} : { failedAt: result.failedAt }),
    ...(result.bundle === undefined ? {} : { bundle: result.bundle }),
    ...(result.pendingBuilds === undefined ? {} : { pendingBuilds: result.pendingBuilds }),
  }
}

function validatedPayload(value: unknown): SuccessfulFeatureResponse['payload'] | undefined {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'plugin-install-recovery-validation',
    ok: true,
    payload: value,
  })
  return parsed.success && parsed.data.ok ? parsed.data.payload : undefined
}

function isPluginInstallNotStarted(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'PLUGIN_INSTALL_NOT_STARTED'
  )
}
