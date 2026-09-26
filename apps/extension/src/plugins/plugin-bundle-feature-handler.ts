import type {
  PluginBuildApprovalConfirmation,
  PluginBundleEnableConfirmation,
  PluginBundleRemoveConfirmation,
  PluginBundleUseCases,
  PluginEntryEnableConfirmation,
  PluginInstallConfirmation,
} from '@dsh-vscode/application'
import { createHash } from 'node:crypto'
import {
  pluginInstallNotStartedError,
  type PluginInstallCancellation,
  type PluginRegistry,
} from '@dsh-vscode/domain'
import { featureResponseSchema } from '@dsh-vscode/webview-protocol'

export type PluginBundleFeatureRequest =
  | { readonly type: 'plugin.bundles.list'; readonly payload: Record<string, never> }
  | { readonly type: 'plugin.registries.list'; readonly payload: Record<string, never> }
  | {
      readonly type: 'plugin.spec.inspect'
      readonly payload: { readonly spec: string; readonly registry?: PluginRegistry | undefined }
    }
  | {
      readonly type: 'plugin.bundle.install'
      readonly payload: {
        readonly spec: string
        readonly installRequestId: string
        readonly registry?: PluginRegistry | undefined
        readonly approvedBuilds?: readonly string[] | undefined
      }
    }
  | { readonly type: 'plugin.bundle.cancelInstall'; readonly payload: { readonly installRequestId: string } }
  | { readonly type: 'plugin.bundle.waitForInstall'; readonly payload: { readonly installRequestId: string } }
  | {
      readonly type: 'plugin.bundle.setEnabled'
      readonly payload: { readonly name: string; readonly enabled: boolean }
    }
  | { readonly type: 'plugin.bundle.remove'; readonly payload: { readonly name: string } }
  | {
      readonly type: 'plugin.entry.setEnabled'
      readonly payload: { readonly entryId: string; readonly enabled: boolean }
    }

/** Route RC2 Plugin Manager operations through validated application use cases. */
export async function handlePluginBundleFeatureRequest(
  request: PluginBundleFeatureRequest,
  bundles: PluginBundleUseCases,
  signal: AbortSignal,
  confirmations?: {
    readonly enable?: PluginBundleEnableConfirmation
    readonly pluginEntryEnable?: PluginEntryEnableConfirmation
    readonly install?: PluginInstallConfirmation
    readonly remove?: PluginBundleRemoveConfirmation
    readonly builds?: PluginBuildApprovalConfirmation
  },
  coordinator?: PluginInstallRequestCoordinator,
): Promise<unknown> {
  switch (request.type) {
    case 'plugin.bundles.list':
      return { kind: 'plugin.bundles', ...(await bundles.list(signal)) }
    case 'plugin.registries.list': {
      const registries = await bundles.registries(signal)
      return {
        kind: 'plugin.registries',
        available: registries !== undefined,
        registries: registries ?? null,
      }
    }
    case 'plugin.spec.inspect':
      return {
        kind: 'plugin.inspection',
        inspection: await bundles.inspect(request.payload.spec, request.payload.registry, signal),
      }
    case 'plugin.bundle.install': {
      const cancelInstallRemote =
        coordinator === undefined
          ? undefined
          : (installRequestId: string) =>
              coordinator.cancelRemote(installRequestId, () => bundles.cancelInstall(installRequestId))
      const run = async (installSignal: AbortSignal = signal): Promise<unknown> => ({
        kind: 'plugin.bundle.changed',
        result: await bundles.install(
          request.payload.spec,
          request.payload.installRequestId,
          request.payload.registry,
          request.payload.approvedBuilds,
          installSignal,
          confirmations?.install,
          confirmations?.builds,
          cancelInstallRemote,
        ),
      })
      return coordinator === undefined
        ? run()
        : coordinator.install(
            request.payload.installRequestId,
            signal,
            run,
            installRequestIdentity(request.payload),
          )
    }
    case 'plugin.bundle.cancelInstall': {
      const run = (): Promise<PluginInstallCancellation> =>
        bundles.cancelInstall(request.payload.installRequestId, signal)
      const cancellation =
        coordinator === undefined
          ? await run()
          : await coordinator.cancel(request.payload.installRequestId, run)
      return { kind: 'plugin.install.cancelled', ...cancellation }
    }
    case 'plugin.bundle.waitForInstall': {
      const run = async (): Promise<unknown> => ({
        kind: 'plugin.install.waited',
        result: await bundles.waitForInstall(request.payload.installRequestId, signal),
      })
      return coordinator === undefined ? run() : coordinator.wait(request.payload.installRequestId, run)
    }
    case 'plugin.bundle.setEnabled':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.setEnabled(
          request.payload.name,
          request.payload.enabled,
          signal,
          confirmations?.enable,
        ),
      }
    case 'plugin.bundle.remove':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.remove(request.payload.name, signal, confirmations?.remove),
      }
    case 'plugin.entry.setEnabled':
      return {
        kind: 'plugin.bundle.changed',
        result: await bundles.setPluginEnabled(
          request.payload.entryId,
          request.payload.enabled,
          signal,
          confirmations?.pluginEntryEnable,
        ),
      }
  }
}

/** Keep installs idempotent by their DSH request id; coalesce concurrent wait/cancel Remotes. */
export class PluginInstallRequestCoordinator {
  private readonly installs = new Map<string, TrackedRequest>()
  private readonly cancellations = new Map<string, TrackedRequest>()
  private readonly waits = new Map<string, TrackedRequest>()
  private readonly cancellationSignals = new Map<string, InstallCancellationSignal>()

  public install(
    requestId: string,
    requestSignal: AbortSignal,
    run: (signal: AbortSignal) => Promise<unknown>,
    identity: string,
  ): Promise<unknown> {
    return this.once(
      this.installs,
      requestId,
      () => {
        const cancellation = this.cancellationSignal(requestId, true)
        const combined = combineAbortSignals(requestSignal, cancellation.controller.signal)
        return run(combined.signal).finally(() => {
          combined.dispose()
          this.releaseCancellationSignal(requestId, cancellation)
        })
      },
      true,
      identity,
    )
  }

  public cancel(
    requestId: string,
    run: () => Promise<PluginInstallCancellation>,
  ): Promise<PluginInstallCancellation> {
    // Latch intent before the Remote call starts. A cancel may overtake the
    // install handler, or land while its Host-side inspect/confirmation is
    // still running; the install's combined signal covers both windows.
    this.cancellationSignal(requestId, false).controller.abort()
    // Cancellation is only coalesced while its Remote call is in flight. A
    // settled `not-running` may precede DSH registering the install request;
    // the same id must reach the Remote again when the user retries. Terminal
    // outcomes stay cached so duplicate cancel messages cannot reverse them.
    return this.cancelRemote(requestId, run)
  }

  /** Share the Remote cancellation promise with the install AbortSignal handler. */
  public cancelRemote(
    requestId: string,
    run: () => Promise<PluginInstallCancellation>,
  ): Promise<PluginInstallCancellation> {
    return this.once(
      this.cancellations,
      requestId,
      run,
      isTerminalCancellation,
    ) as Promise<PluginInstallCancellation>
  }

  private cancellationSignal(requestId: string, activeInstall: boolean): InstallCancellationSignal {
    this.pruneCancellationSignals()
    const existing = this.cancellationSignals.get(requestId)
    if (existing !== undefined) {
      if (activeInstall) existing.activeInstall = true
      return existing
    }
    if (this.cancellationSignals.size >= MAX_TRACKED_INSTALL_REQUESTS)
      throw new Error('Too many plugin install cancellations are active.')
    const cancellation: InstallCancellationSignal = {
      controller: new AbortController(),
      createdAt: Date.now(),
      activeInstall,
    }
    this.cancellationSignals.set(requestId, cancellation)
    return cancellation
  }

  private releaseCancellationSignal(requestId: string, cancellation: InstallCancellationSignal): void {
    if (this.cancellationSignals.get(requestId) !== cancellation) return
    cancellation.activeInstall = false
    this.cancellationSignals.delete(requestId)
  }

  private pruneCancellationSignals(): void {
    const expiredBefore = Date.now() - INSTALL_REQUEST_CACHE_TTL_MS
    for (const [requestId, cancellation] of this.cancellationSignals) {
      if (!cancellation.activeInstall && cancellation.createdAt <= expiredBefore)
        this.cancellationSignals.delete(requestId)
    }
  }

  public wait(requestId: string, run: () => Promise<unknown>): Promise<unknown> {
    this.prune(this.installs)
    const cachedInstall = this.installs.get(requestId)?.outcome
    if (cachedInstall?.status === 'fulfilled') {
      const recovered = projectCompletedInstall(cachedInstall.value)
      if (recovered !== undefined) return Promise.resolve(recovered)
    }
    return this.once(this.waits, requestId, run, false)
  }

  private once(
    requests: Map<string, TrackedRequest>,
    requestId: string,
    run: () => Promise<unknown>,
    retain: RetentionPolicy,
    identity?: string,
  ): Promise<unknown> {
    this.prune(requests)
    const existing = requests.get(requestId)
    if (existing !== undefined) {
      if (existing.identity !== identity) return Promise.reject(pluginInstallNotStartedError())
      return existing.promise
    }
    if (requests.size >= MAX_TRACKED_INSTALL_REQUESTS) {
      const oldestSettled = [...requests.entries()]
        .filter(([, entry]) => entry.settledAt !== undefined)
        .sort((left, right) => (left[1].settledAt ?? 0) - (right[1].settledAt ?? 0))[0]
      if (oldestSettled !== undefined) requests.delete(oldestSettled[0])
    }
    if (requests.size >= MAX_TRACKED_INSTALL_REQUESTS)
      return Promise.reject(new Error('Too many plugin install requests are active.'))
    const result = Promise.resolve().then(run)
    const entry: TrackedRequest = {
      promise: result,
      ...(identity === undefined ? {} : { identity }),
    }
    requests.set(requestId, entry)
    void result.then(
      (value) => this.settled(requests, requestId, entry, retain, { status: 'fulfilled', value }),
      () => this.settled(requests, requestId, entry, retain, { status: 'rejected' }),
    )
    return result
  }

  private settled(
    requests: Map<string, TrackedRequest>,
    requestId: string,
    entry: TrackedRequest,
    retain: RetentionPolicy,
    outcome: RequestOutcome,
  ): void {
    if (requests.get(requestId) !== entry) return
    entry.outcome = outcome
    const keep =
      typeof retain === 'function' ? outcome.status === 'fulfilled' && retain(outcome.value) : retain
    if (keep) entry.settledAt = Date.now()
    else requests.delete(requestId)
  }

  private prune(requests: Map<string, TrackedRequest>): void {
    const expiredBefore = Date.now() - INSTALL_REQUEST_CACHE_TTL_MS
    for (const [requestId, entry] of requests) {
      if (entry.settledAt !== undefined && entry.settledAt <= expiredBefore) requests.delete(requestId)
    }
  }
}

interface TrackedRequest {
  readonly promise: Promise<unknown>
  /** Non-reversible install-input digest; never retain or log the package spec itself. */
  readonly identity?: string
  settledAt?: number
  outcome?: RequestOutcome
}

interface InstallCancellationSignal {
  readonly controller: AbortController
  readonly createdAt: number
  activeInstall: boolean
}

interface CombinedAbortSignal {
  readonly signal: AbortSignal
  dispose(): void
}

type RequestOutcome =
  { readonly status: 'fulfilled'; readonly value: unknown } | { readonly status: 'rejected' }

type RetentionPolicy = boolean | ((value: unknown) => boolean)

function isTerminalCancellation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return payload.status === 'cancelled' || payload.status === 'too-late'
}

function projectCompletedInstall(value: unknown): unknown {
  const parsed = featureResponseSchema.safeParse({
    type: 'feature.response',
    requestId: 'plugin-install-cache-result',
    ok: true,
    payload: value,
  })
  if (!parsed.success || !('payload' in parsed.data)) return undefined
  const payload = parsed.data.payload
  if (payload.kind !== 'plugin.bundle.changed' || payload.result.stage !== 'install') return undefined
  return { kind: 'plugin.install.waited', result: payload.result }
}

function installRequestIdentity(
  payload: Extract<PluginBundleFeatureRequest, { readonly type: 'plugin.bundle.install' }>['payload'],
): string {
  const registry = payload.registry === undefined ? ['omitted'] : ['provided', payload.registry]
  const approvedBuilds =
    payload.approvedBuilds === undefined ? ['omitted'] : ['provided', ...payload.approvedBuilds]
  return createHash('sha256')
    .update(JSON.stringify([payload.spec, registry, approvedBuilds]), 'utf8')
    .digest('hex')
}

const MAX_TRACKED_INSTALL_REQUESTS = 128
const INSTALL_REQUEST_CACHE_TTL_MS = 30 * 60_000

function combineAbortSignals(...signals: readonly AbortSignal[]): CombinedAbortSignal {
  const controller = new AbortController()
  const sources: AbortSignal[] = []
  const abort = (): void => controller.abort()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    sources.push(signal)
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const source of sources) source.removeEventListener('abort', abort)
    },
  }
}
