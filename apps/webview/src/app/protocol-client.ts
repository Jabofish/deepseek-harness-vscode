import {
  hostEnvelopeSchema,
  PROTOCOL_VERSION,
  featureHostEnvelopeSchema,
  featureWebviewEnvelopeSchema,
  webviewRequestSchema,
  type FeatureHostEvent,
  type FeatureHostMessage,
  type FeatureRequest,
  type HostMessage,
  type WebviewRequest,
} from '@dsh-vscode/webview-protocol'

import { translate } from '../i18n.js'
import type { VsCodeApi } from '../vscode-api.js'

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
  readonly timer: number
}

interface FeatureBackendIdentity {
  readonly backendInstanceId: string
  readonly connectionGeneration: number
}

// npm installation is a host-side operation and may legitimately take longer
// than ordinary chat/settings requests. Keep the Webview pending until the
// Extension Host can return the real result instead of turning a slow download
// into a misleading generic timeout.
const RUNTIME_UPDATE_CHECK_TIMEOUT_MS = 45_000
const RUNTIME_UPDATE_INSTALL_TIMEOUT_MS = 180_000

const timeoutError = (): Error => {
  const error = new Error(translate('app.error.timeout'))
  Object.assign(error, { retryable: true })
  return error
}

export class ProtocolClient {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<(message: HostMessage) => void>()
  private readonly featureListeners = new Set<(message: FeatureHostEvent) => void>()
  private readonly sequences = new Map<string, number>()
  private readonly featureSequences = new Map<string, number>()
  private readonly featureGenerations = new Map<string, number>()
  private featureBackendIdentity: FeatureBackendIdentity | undefined
  private featureConnectionKnown = false
  private disposed = false
  private readonly windowListener = (event: MessageEvent<unknown>): void => this.handle(event.data)

  public constructor(
    private readonly api: VsCodeApi,
    private readonly timeoutMs = 30_000,
  ) {
    window.addEventListener('message', this.windowListener)
  }

  public request<T>(request: WebviewRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(translate('app.error.disposed')))
    const parsed = webviewRequestSchema.parse(request)
    if (this.pending.has(parsed.requestId))
      return Promise.reject(new Error(translate('app.error.duplicateRequest')))
    return new Promise<T>((resolve, reject) => {
      const timeoutMs =
        parsed.type === 'runtime.update.install'
          ? Math.max(this.timeoutMs, RUNTIME_UPDATE_INSTALL_TIMEOUT_MS)
          : parsed.type === 'runtime.update.check'
            ? Math.max(this.timeoutMs, RUNTIME_UPDATE_CHECK_TIMEOUT_MS)
            : this.timeoutMs
      const timer = window.setTimeout(() => {
        this.pending.delete(parsed.requestId)
        reject(timeoutError())
      }, timeoutMs)
      this.pending.set(parsed.requestId, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.api.postMessage({ protocolVersion: PROTOCOL_VERSION, message: parsed })
      } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(parsed.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Request the staged, strict feature surface without widening legacy schemas. */
  public featureRequest<T>(request: FeatureRequest): Promise<T> {
    if (this.disposed) return Promise.reject(new Error(translate('app.error.disposed')))
    const parsed = featureWebviewEnvelopeSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      message: request,
    }).message
    if (this.pending.has(parsed.requestId))
      return Promise.reject(new Error(translate('app.error.duplicateRequest')))
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(parsed.requestId)
        reject(timeoutError())
      }, this.timeoutMs)
      this.pending.set(parsed.requestId, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.api.postMessage({ protocolVersion: PROTOCOL_VERSION, message: parsed })
      } catch (error) {
        window.clearTimeout(timer)
        this.pending.delete(parsed.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  public handle(rawMessage: unknown): void {
    const parsed = hostEnvelopeSchema.safeParse(rawMessage)
    if (parsed.success) {
      this.handleLegacyMessage(parsed.data.message)
      return
    }
    const feature = featureHostEnvelopeSchema.safeParse(rawMessage)
    if (!feature.success) return
    this.handleFeatureMessage(feature.data.message)
  }

  public subscribeFeature(listener: (message: FeatureHostEvent) => void): () => void {
    this.featureListeners.add(listener)
    return () => this.featureListeners.delete(listener)
  }

  private handleLegacyMessage(message: HostMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId)
      if (pending === undefined) return
      this.pending.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.payload)
      else {
        const error = new Error(message.error?.message ?? translate('app.error.hostUnspecified'))
        if (message.error !== undefined) Object.assign(error, message.error)
        pending.reject(error)
      }
      return
    }
    const previous = this.sequences.get(message.name) ?? -1
    if (message.sequence <= previous) return
    this.sequences.set(message.name, message.sequence)
    if (message.name === 'connection.snapshot' || message.name === 'connection.lost')
      this.updateFeatureBackendIdentity(
        message.name === 'connection.lost' ? { kind: 'lost' } : message.payload,
      )
    for (const listener of this.listeners) listener(message)
  }

  private handleFeatureMessage(message: FeatureHostMessage): void {
    if (message.type === 'feature.response') {
      const pending = this.pending.get(message.requestId)
      if (pending === undefined) return
      this.pending.delete(message.requestId)
      window.clearTimeout(pending.timer)
      if (message.ok) pending.resolve(message.payload)
      else {
        const error = new Error(message.error.message)
        Object.assign(error, message.error)
        pending.reject(error)
      }
      return
    }
    const identity = message.identity
    if (this.featureConnectionKnown) {
      const current = this.featureBackendIdentity
      if (current === undefined) return
      if (identity.backendInstanceId !== current.backendInstanceId) return
      if (identity.connectionGeneration < current.connectionGeneration) return
      if (identity.connectionGeneration > current.connectionGeneration) {
        this.featureBackendIdentity = {
          backendInstanceId: identity.backendInstanceId,
          connectionGeneration: identity.connectionGeneration,
        }
        this.featureSequences.clear()
        this.featureGenerations.clear()
      }
    } else {
      this.featureBackendIdentity = {
        backendInstanceId: identity.backendInstanceId,
        connectionGeneration: identity.connectionGeneration,
      }
    }
    const generationKey = [identity.backendInstanceId, identity.stream, identity.sessionId ?? ''].join(':')
    const previousGeneration = this.featureGenerations.get(generationKey)
    if (previousGeneration !== undefined && identity.connectionGeneration < previousGeneration) return
    if (previousGeneration === undefined || identity.connectionGeneration > previousGeneration)
      this.featureGenerations.set(generationKey, identity.connectionGeneration)
    const key = [
      identity.backendInstanceId,
      identity.connectionGeneration,
      identity.stream,
      identity.sessionId ?? '',
    ].join(':')
    const sequence = identity.stream === 'mux' ? identity.serverSeq : identity.localSeq
    const previous = this.featureSequences.get(key) ?? -1
    if (sequence <= previous) return
    this.featureSequences.set(key, sequence)
    for (const listener of this.featureListeners) listener(message)
  }

  private updateFeatureBackendIdentity(payload: unknown): void {
    this.featureConnectionKnown = true
    const snapshot = object(payload)
    if (snapshot?.kind !== 'connected') {
      this.featureBackendIdentity = undefined
      this.featureSequences.clear()
      this.featureGenerations.clear()
      return
    }
    const backendInstanceId =
      typeof snapshot.backendInstanceId === 'string' ? snapshot.backendInstanceId : undefined
    const connectionGeneration =
      typeof snapshot.connectionGeneration === 'number' &&
      Number.isSafeInteger(snapshot.connectionGeneration) &&
      snapshot.connectionGeneration >= 0
        ? snapshot.connectionGeneration
        : undefined
    if (backendInstanceId === undefined || connectionGeneration === undefined) {
      this.featureBackendIdentity = undefined
      this.featureSequences.clear()
      this.featureGenerations.clear()
      return
    }
    const current = this.featureBackendIdentity
    if (
      current !== undefined &&
      current.backendInstanceId === backendInstanceId &&
      connectionGeneration < current.connectionGeneration
    )
      return
    if (
      current === undefined ||
      current.backendInstanceId !== backendInstanceId ||
      current.connectionGeneration !== connectionGeneration
    ) {
      this.featureSequences.clear()
      this.featureGenerations.clear()
    }
    this.featureBackendIdentity = { backendInstanceId, connectionGeneration }
  }

  public subscribe(listener: (message: HostMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('message', this.windowListener)
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error(translate('app.error.webviewDisposed')))
    }
    this.pending.clear()
    this.listeners.clear()
    this.featureListeners.clear()
    this.featureSequences.clear()
    this.featureGenerations.clear()
    this.featureBackendIdentity = undefined
    this.featureConnectionKnown = false
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
