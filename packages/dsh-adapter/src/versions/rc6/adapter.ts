import {
  AppError,
  type BackendCandidate,
  type BackendCapabilities,
  type BackendEndpoint,
  type ConnectedBackend,
  type DshBackend,
} from '@dsh-vscode/domain'

import {
  isKnownDshVersion,
  LATEST_SUPPORTED_DSH_VERSION,
  normalizeDshVersion,
  SUPPORTED_DSH_RANGE,
  type DshTransport,
  type DshVersionAdapter,
} from '../../contracts.js'
import { LoopbackApiClient, type LoopbackApiClientOptions } from '../../loopback-api-client.js'
import { Rc6CommandRepository } from '../../repositories/command-repository.js'
import { Rc6CredentialRepository } from '../../repositories/credential-repository.js'
import { Rc6ExportRepository, type ExportFileSystem } from '../../repositories/export-repository.js'
import { Rc6MessageFeedbackRepository } from '../../repositories/feedback-repository.js'
import { Rc6GoalRepository } from '../../repositories/goal-repository.js'
import { Rc6InteractionRepository } from '../../repositories/interaction-repository.js'
import { Rc6JobRepository } from '../../repositories/job-repository.js'
import { Rc6ModelRepository } from '../../repositories/model-repository.js'
import { Rc6PluginRepository } from '../../repositories/plugin-repository.js'
import { Rc6PresetRepository } from '../../repositories/preset-repository.js'
import { Rc6ReferenceRepository } from '../../repositories/reference-repository.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SettingsRepository } from '../../repositories/settings-repository.js'
import { Rc6SkillRepository } from '../../repositories/skill-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { DshStreamController } from '../../stream-controller.js'
import { callRpc } from './rpc.js'

export type Rc6AdapterOptions = Omit<LoopbackApiClientOptions, 'endpoint'> & {
  /** Extension-Host path identity; the adapter must not touch platform FS APIs. */
  readonly samePath?: (left: string, right: string) => boolean
  /** Authorized Extension-Host writer for user-selected export destinations. */
  readonly exportFileSystem?: ExportFileSystem
}

export class Rc6VersionAdapter implements DshVersionAdapter {
  public readonly id: string = 'dsh-0.1.0-rc.6'
  public readonly supportedVersion: string = '0.1.0-rc.6'
  public readonly fallback: boolean = true

  public readonly protocolVersion: string = 'rc6'
  protected readonly requiresHome: boolean = false

  public constructor(protected readonly options: Rc6AdapterOptions) {}

  public async probe(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    const transport = this.createTransport(candidate.endpoint)
    try {
      const described = await callRpc<{
        version: string
        cwd: string
        attachedSessions: number
        canOpenPath: boolean
        home?: string
      }>(transport, 'host.describe', {}, signal)
      // The rc.6 host contract deliberately does not negotiate a protocol
      // version. `host.describe.version` is the host application's package
      // version and may legitimately differ from the CLI package version
      // (the live rc.6 host reports 0.0.1 while the CLI is 0.1.0-rc.6).
      // Compatibility is established by the pinned API call succeeding with
      // a non-empty host version; an independently released protocol would
      // require a new adapter contract.
      if (typeof described.version !== 'string' || described.version.trim() === '') {
        throw new AppError({
          code: 'DSH_INCOMPATIBLE',
          message: 'The endpoint did not report a compatible DSH host version.',
          retryable: false,
        })
      }
      if (this.requiresHome && (typeof described.home !== 'string' || described.home.trim() === ''))
        return undefined
      const hintedVersion = normalizeDshVersion(candidate.runtimeVersion)
      if (!this.acceptsRuntimeHint(hintedVersion)) return undefined
      const reportedVersion = hintedVersion ?? 'unknown'
      const compatibilityWarning =
        hintedVersion === undefined
          ? `The DSH runtime did not expose its package version; compatibility is being checked against ${LATEST_SUPPORTED_DSH_VERSION} (${SUPPORTED_DSH_RANGE}).`
          : !isKnownDshVersion(hintedVersion)
            ? `DSH ${hintedVersion} is outside the tested compatibility range (${SUPPORTED_DSH_RANGE}); basic compatibility mode is active.`
            : undefined
      return {
        protocolVersion: this.protocolVersion,
        dshVersion: reportedVersion,
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
        ]),
        ...(compatibilityWarning === undefined ? {} : { compatibilityWarning }),
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'DSH_INCOMPATIBLE') throw error
      return undefined
    } finally {
      await transport.close()
    }
  }

  /** rc.6 is the protocol-compatible fallback for unknown future runtimes. */
  protected acceptsRuntimeHint(version: string | undefined): boolean {
    return version === undefined || version === this.supportedVersion || !isKnownDshVersion(version)
  }

  public createTransport(endpoint: BackendEndpoint): DshTransport {
    return new LoopbackApiClient({ ...this.options, endpoint })
  }

  public createBackend(backend: ConnectedBackend): Promise<DshBackend> {
    const transport = this.createTransport(backend.endpoint)
    const interactions = new Rc6InteractionRepository(transport)
    const workspaces = new Rc6WorkspaceRepository(transport)
    const sessions = this.createSessionRepository(transport, workspaces)
    const goals = new Rc6GoalRepository(transport)
    const jobs = new Rc6JobRepository(transport)
    const events = new DshStreamController(
      transport,
      (event) => {
        interactions.remember(event)
        sessions.remember(event)
        goals.remember(event)
        jobs.remember(event)
      },
      async (sessionId, fromSequence, toSequence, signal) => {
        const detail = await sessions.get(sessionId, signal)
        return (detail.history ?? [])
          .filter((entry) => entry.sequence >= fromSequence && entry.sequence <= toSequence)
          .map((entry) => entry.event)
      },
    )
    let closed = false
    return Promise.resolve({
      connection: backend,
      sessions,
      workspaces,
      models: new Rc6ModelRepository(transport),
      credentials: new Rc6CredentialRepository(transport),
      interactions,
      goals,
      jobs,
      subagents: new Rc6SubagentRepository(transport),
      settings: new Rc6SettingsRepository(transport),
      skills: new Rc6SkillRepository(transport),
      commands: this.createCommandRepository(transport),
      plugins: new Rc6PluginRepository(transport),
      presets: new Rc6PresetRepository(transport),
      exports: new Rc6ExportRepository(transport, this.options.exportFileSystem),
      references: new Rc6ReferenceRepository(transport),
      feedback: new Rc6MessageFeedbackRepository(transport),
      events,
      close: async () => {
        if (closed) return
        closed = true
        await events.close()
        await transport.close()
      },
    })
  }

  /** Version adapters may select the exact Remote argument shape they serve. */
  protected createCommandRepository(transport: DshTransport): Rc6CommandRepository {
    return new Rc6CommandRepository(transport)
  }

  protected createSessionRepository(
    transport: DshTransport,
    workspaces: Rc6WorkspaceRepository,
  ): Rc6SessionRepository {
    return new Rc6SessionRepository(transport, workspaces, this.options.samePath)
  }
}
