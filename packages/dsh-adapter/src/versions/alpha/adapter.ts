import { workspaceChangeSource } from '../alpha162/workspace-changes.js'
import {
  type BackendCandidate,
  type BackendCapabilities,
  type BackendEndpoint,
  type ConnectedBackend,
  type DshBackend,
  type BackendEvent,
  type PluginRepository,
  type PresetRepository,
} from '@dsh-vscode/domain'

import { DshVersionAdapterBase, type VersionAdapterIdentity } from '../../adapter-base.js'
import {
  isKnownDshVersion,
  isMalformedDshVersionHint,
  normalizeDshVersion,
  type DshTransport,
} from '../../contracts.js'
import { withBestEffortAdapterCapabilities, withExactAdapterCapabilities } from '../../compatibility.js'
import type { Rc6AdapterOptions } from '../rc6/adapter.js'
import type { ExportFileSystem } from '../../repositories/export-repository.js'
import { Rc6CommandRepository, type CommandAttachmentWire } from '../../repositories/command-repository.js'
import { Rc6CredentialRepository } from '../../repositories/credential-repository.js'
import { Rc6ExportRepository } from '../../repositories/export-repository.js'
import { Rc6MessageFeedbackRepository } from '../../repositories/feedback-repository.js'
import { Rc6GoalRepository } from '../../repositories/goal-repository.js'
import { Rc6InteractionRepository } from '../../repositories/interaction-repository.js'
import { Rc6JobRepository, type EventAwareJobRepository } from '../../repositories/job-repository.js'
import { Rc6ModelRepository } from '../../repositories/model-repository.js'
import { Rc6PluginRepository } from '../../repositories/plugin-repository.js'
import { Rc6PresetRepository } from '../../repositories/preset-repository.js'
import { Rc6ReferenceRepository } from '../../repositories/reference-repository.js'
import { historyGapRecovery, Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SettingsRepository } from '../../repositories/settings-repository.js'
import { Rc6SkillRepository } from '../../repositories/skill-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { SubagentAddressRegistry } from '../../repositories/shared/subagent-addresses.js'
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
  protected readonly supportsWorkspaceChanges: boolean = false
  protected readonly supportsLiveGoal: boolean = false
  protected readonly supportsFileUploads: boolean = false
  protected readonly supportsInlineSubagentImages: boolean = false
  /** Only the 0.1.6 alpha line exposes the upstream unarchive Remote. */
  protected readonly supportsSessionRestore: boolean = false
  /** Only DSH 0.1.3-alpha.2 requires `subagent.prompt.delivery`. */
  protected readonly supportsSubagentPromptDelivery: boolean = false
  /** 0.1.3-alpha.1 renamed the commands/execute attachment parameter. */
  protected readonly commandAttachmentWire: CommandAttachmentWire = 'images'
  /** New Session Control profiles supplement host queues from durable follow snapshots. */
  protected readonly queueBaselineMode: 'control' | 'control-follow' = 'control'

  protected permissionCatalogReader(
    _transport: DshTransport,
  ): ((signal?: AbortSignal) => Promise<readonly string[]>) | undefined {
    return undefined
  }

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
    if (isMalformedDshVersionHint(candidate.runtimeVersion)) return undefined
    const hintedVersion = normalizeDshVersion(candidate.runtimeVersion)
    if (!compatibility && candidate.runtimeVersion !== hintedVersion) return undefined
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
        sessionRestore: this.supportsSessionRestore && !compatibility,
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
    // One routing table for child sessions: the catalog commits it and the
    // transport reuses it, so a child's live stream and history pages carry the
    // durable descriptor the Session Controller requires for subagent Sessions.
    const subagentAddresses = new SubagentAddressRegistry()
    const transport = new AlphaLoopbackApiClient({
      ...this.createTransportOptions(backend.endpoint),
      subagentAddresses,
    })
    const eventsHolder: { value?: AlphaEventSource } = {}
    const interactions = new Rc6InteractionRepository(transport, {
      resetPendingOnSubscribe: false,
      // Alpha never echoes a settlement to the client that performed it, so the
      // accepted answer must be published locally. Otherwise the Host replay
      // cache re-posts the settled request after every Webview reload and the
      // task center keeps a needs-input row that can only fail.
      onSettled: (event) => eventsHolder.value?.publish(event),
    })
    const workspaces = new Rc6WorkspaceRepository(transport, {
      supportsSessionRestore: this.supportsSessionRestore,
    })
    const sessions = new Rc6SessionRepository(transport, workspaces, this.options.samePath, {
      preallocatedSessionId: true,
      supportsSessionRestore: this.supportsSessionRestore,
      supportsFileUploads: this.supportsFileUploads,
      readPermissionPresets: this.permissionCatalogReader(transport),
      commandAttachmentWire: this.commandAttachmentWire,
      maxPromptAttachmentBytes: 20 * 1024 * 1024,
      maxPromptAttachmentTotalBytes: 200 * 1024 * 1024,
      onSessionAccess: (sessionId) => eventsHolder.value?.watchSession(sessionId),
      onSessionOpen: (sessionId) => eventsHolder.value?.refreshSession(sessionId),
      deriveTitleFromCwd: true,
      // Older alpha profiles baseline queues on the host-wide control stream.
      // Alpha171+ derives the complete queue from each V4 follow projection,
      // because fork children can inherit Inbox state without a control event.
      queueBaseline: this.queueBaselineMode,
    })
    const goals = new Rc6GoalRepository(transport, this.supportsLiveGoal)
    const jobs = this.createJobRepository(transport)
    const observe = (event: BackendEvent): void => {
      interactions.remember(event)
      sessions.remember(event)
      goals.remember(event)
      jobs.remember(event)
    }
    const events = new AlphaEventSource(
      transport,
      observe,
      historyGapRecovery(sessions),
      jobs.watchRows === undefined ? undefined : (sessionId, signal) => jobs.watchRows!(sessionId, signal),
    )
    eventsHolder.value = events
    let closed = false
    const backendValue: DshBackend = {
      connection: backend,
      ...(this.supportsWorkspaceChanges ? { workspaceChanges: workspaceChangeSource(transport) } : {}),
      sessions,
      workspaces,
      models: new Rc6ModelRepository(transport),
      credentials: new Rc6CredentialRepository(transport),
      interactions,
      goals,
      jobs,
      subagents: new Rc6SubagentRepository(transport, {
        inlineImagePrompts: backend.capabilities.subagentImagePrompts === true,
        subagentPromptDelivery: this.supportsSubagentPromptDelivery,
        maxPromptAttachmentBytes: 20 * 1024 * 1024,
        maxPromptAttachmentTotalBytes: 200 * 1024 * 1024,
        addresses: subagentAddresses,
      }),
      settings: new Rc6SettingsRepository(transport),
      skills: new Rc6SkillRepository(transport),
      commands: new Rc6CommandRepository(transport, this.commandAttachmentWire),
      plugins: this.createPluginRepository(transport),
      presets: this.createPresetRepository(transport),
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

  /** Allow a release seam to replace the old session-control-backed Job source. */
  protected createJobRepository(transport: AlphaLoopbackApiClient): EventAwareJobRepository {
    return new Rc6JobRepository(transport, { resetOnSubscribe: false })
  }

  /** Allow a release seam to replace changed plugin-inventory fields. */
  protected createPluginRepository(transport: AlphaLoopbackApiClient): PluginRepository {
    return new Rc6PluginRepository(transport)
  }

  /** Allow a release seam to replace changed preset-roster fields and methods. */
  protected createPresetRepository(transport: AlphaLoopbackApiClient): PresetRepository {
    return new Rc6PresetRepository(transport)
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
