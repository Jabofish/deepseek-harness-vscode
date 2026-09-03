import {
  type BackendCandidate,
  type BackendCapabilities,
  type BackendEndpoint,
  type ConnectedBackend,
  type DshBackend,
  type BackendEvent,
} from '@dsh-vscode/domain'

import { DshVersionAdapterBase, type VersionAdapterIdentity } from '../../adapter-base.js'
import { isKnownDshVersion, normalizeDshVersion, type DshTransport } from '../../contracts.js'
import { withBestEffortAdapterCapabilities, withExactAdapterCapabilities } from '../../compatibility.js'
import type { Rc6AdapterOptions } from '../rc6/adapter.js'
import type { ExportFileSystem } from '../../repositories/export-repository.js'
import { Rc8CommandRepository } from '../../repositories/command-repository.js'
import { Rc6CredentialRepository } from '../../repositories/credential-repository.js'
import { Rc6ExportRepository } from '../../repositories/export-repository.js'
import { Rc6MessageFeedbackRepository } from '../../repositories/feedback-repository.js'
import { Rc6GoalRepository } from '../../repositories/goal-repository.js'
import { Rc6InteractionRepository } from '../../repositories/interaction-repository.js'
import { Rc6JobRepository } from '../../repositories/job-repository.js'
import { Rc6ModelRepository } from '../../repositories/model-repository.js'
import { Rc6PluginRepository } from '../../repositories/plugin-repository.js'
import { Rc6PresetRepository } from '../../repositories/preset-repository.js'
import { Rc6ReferenceRepository } from '../../repositories/reference-repository.js'
import { historyGapRecovery, Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SettingsRepository } from '../../repositories/settings-repository.js'
import { Rc6SkillRepository } from '../../repositories/skill-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { AlphaEventSource } from './events.js'
import {
  AlphaLoopbackApiClient,
  type AlphaLoopbackApiClientOptions,
  type AlphaWebSocketConstructor,
} from './transport.js'
import { callRpc } from '../rc6/rpc.js'
import { deriveFeatureCapabilityProfile } from '../../feature-capabilities.js'

export type AlphaAdapterOptions = Omit<Rc6AdapterOptions, 'webSocket'> & {
  readonly authCookie?: (endpoint: BackendEndpoint) => string | undefined
  readonly webSocket?: AlphaWebSocketConstructor
  readonly exportFileSystem?: ExportFileSystem
}

/** Shared adapter assembly for the verified 0.1.2 alpha Connection/Gateway contract. */
export class Alpha1VersionAdapter extends DshVersionAdapterBase {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.2-alpha.1',
    supportedVersion: '0.1.2-alpha.1',
    protocolVersion: 'alpha1',
    compatibilityPriority: 80,
    fallback: false,
  }

  /** Alpha.1/2 accept only text/content blocks on the subagent wire. */
  protected readonly supportsInlineSubagentImages: boolean = false

  public constructor(protected readonly options: AlphaAdapterOptions) {
    super()
  }

  public async probe(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    return this.probeAlpha(candidate, signal, false)
  }

  public async probeCompatibility(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    return this.probeAlpha(candidate, signal, true)
  }

  private async probeAlpha(
    candidate: BackendCandidate,
    signal: AbortSignal | undefined,
    compatibility: boolean,
  ): Promise<BackendCapabilities | undefined> {
    const hintedVersion = normalizeDshVersion(candidate.runtimeVersion)
    // Exact probes are still strict. Compatibility probes are a separate,
    // read-only path for a non-empty unknown runtime label; the successful
    // response, not the release suffix, is what permits reuse of this
    // adapter's known contract.
    if (
      compatibility
        ? hintedVersion === undefined || isKnownDshVersion(hintedVersion)
        : hintedVersion !== this.supportedVersion
    )
      return undefined
    const transport = this.createTransport(candidate.endpoint)
    try {
      const value = await callRpc<unknown>(transport, 'session.list', {}, signal)
      if (!isSessionList(value)) return undefined
      const capabilities: BackendCapabilities = {
        protocolVersion: this.protocolVersion,
        dshVersion: this.supportedVersion,
        subagentImagePrompts: this.supportsInlineSubagentImages && !compatibility,
        features: new Set([
          'host',
          'workspace',
          'session',
          'models',
          'settings',
          'credentials',
          'goals',
          'skills',
          'subagents',
          'events',
          'commands',
          'presets',
          'references',
          'feedback',
        ]),
      }
      return compatibility
        ? withBestEffortAdapterCapabilities(capabilities, hintedVersion, this.id)
        : withExactAdapterCapabilities(
            { ...capabilities, featureProfile: deriveFeatureCapabilityProfile(capabilities) },
            this.id,
          )
    } catch (error) {
      if (signal?.aborted === true) throw error
      return undefined
    } finally {
      await transport.close()
    }
  }

  public createTransport(endpoint: BackendEndpoint): DshTransport {
    return new AlphaLoopbackApiClient(this.createTransportOptions(endpoint))
  }

  protected createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    const options: AlphaLoopbackApiClientOptions = {
      ...this.options,
      endpoint,
    }
    return options
  }

  public createBackend(backend: ConnectedBackend): Promise<DshBackend> {
    const transport = this.createTransport(backend.endpoint) as AlphaLoopbackApiClient
    const interactions = new Rc6InteractionRepository(transport, { resetPendingOnSubscribe: false })
    const workspaces = new Rc6WorkspaceRepository(transport)
    const eventsHolder: { value?: AlphaEventSource } = {}
    const sessions = new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      includeEmptyCommandImages: true,
      maxPromptAttachmentBytes: 20 * 1024 * 1024,
      maxPromptAttachmentTotalBytes: 200 * 1024 * 1024,
      onSessionAccess: (sessionId) => eventsHolder.value?.watchSession(sessionId),
      deriveTitleFromCwd: true,
      // Alpha baselines queues on the session/control stream, not on
      // `session/follow`; a subscription must not wipe that state.
      resetQueueOnSubscribe: false,
    })
    const goals = new Rc6GoalRepository(transport)
    const jobs = new Rc6JobRepository(transport, { resetOnSubscribe: false })
    const observe = (event: BackendEvent): void => {
      interactions.remember(event)
      sessions.remember(event)
      goals.remember(event)
      jobs.remember(event)
    }
    const events = new AlphaEventSource(transport, observe, historyGapRecovery(sessions))
    eventsHolder.value = events
    let closed = false
    const backendValue: DshBackend = {
      connection: backend,
      sessions,
      workspaces,
      models: new Rc6ModelRepository(transport),
      credentials: new Rc6CredentialRepository(transport),
      interactions,
      goals,
      jobs,
      subagents: new Rc6SubagentRepository(transport, {
        inlineImagePrompts: backend.capabilities.subagentImagePrompts === true,
        maxPromptAttachmentBytes: 20 * 1024 * 1024,
        maxPromptAttachmentTotalBytes: 200 * 1024 * 1024,
      }),
      settings: new Rc6SettingsRepository(transport),
      skills: new Rc6SkillRepository(transport),
      commands: new Rc8CommandRepository(transport),
      plugins: new Rc6PluginRepository(transport),
      presets: new Rc6PresetRepository(transport),
      exports: new Rc6ExportRepository(transport, this.options.exportFileSystem),
      references: new Rc6ReferenceRepository(transport),
      feedback: new Rc6MessageFeedbackRepository(transport),
      events,
      close: async () => {
        if (closed) return
        closed = true
        await events?.close()
        await transport.close()
      },
    }
    return Promise.resolve(backendValue)
  }
}

function isSessionList(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { readonly items?: unknown }).items)
  )
}

/** @deprecated Use {@link Alpha1VersionAdapter}; retained for source compatibility. */
export { Alpha1VersionAdapter as AlphaVersionAdapter }
