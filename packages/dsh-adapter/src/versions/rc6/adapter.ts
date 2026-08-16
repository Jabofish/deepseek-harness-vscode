import {
  AppError,
  type BackendCandidate,
  type BackendCapabilities,
  type BackendEndpoint,
  type ConnectedBackend,
  type DshBackend,
} from '@dsh-vscode/domain'

import type { DshTransport, DshVersionAdapter } from '../../contracts.js'
import { LoopbackApiClient, type LoopbackApiClientOptions } from '../../loopback-api-client.js'
import { Rc6CommandRepository } from '../../repositories/command-repository.js'
import { Rc6CredentialRepository } from '../../repositories/credential-repository.js'
import { Rc6ExportRepository } from '../../repositories/export-repository.js'
import { Rc6GoalRepository } from '../../repositories/goal-repository.js'
import { Rc6InteractionRepository } from '../../repositories/interaction-repository.js'
import { Rc6JobRepository } from '../../repositories/job-repository.js'
import { Rc6ModelRepository } from '../../repositories/model-repository.js'
import { Rc6PluginRepository } from '../../repositories/plugin-repository.js'
import { Rc6PresetRepository } from '../../repositories/preset-repository.js'
import { Rc6SessionRepository } from '../../repositories/session-repository.js'
import { Rc6SettingsRepository } from '../../repositories/settings-repository.js'
import { Rc6SkillRepository } from '../../repositories/skill-repository.js'
import { Rc6SubagentRepository } from '../../repositories/subagent-repository.js'
import { Rc6WorkflowRepository } from '../../repositories/workflow-repository.js'
import { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { DshStreamController } from '../../stream-controller.js'
import { callRpc } from './rpc.js'

export type Rc6AdapterOptions = Omit<LoopbackApiClientOptions, 'endpoint'>

export class Rc6VersionAdapter implements DshVersionAdapter {
  public readonly id = 'dsh-0.1.0-rc.6'
  public readonly supportedVersion = '0.1.0-rc.6'

  public constructor(private readonly options: Rc6AdapterOptions) {}

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
      return {
        protocolVersion: 'rc6',
        dshVersion: this.supportedVersion,
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
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'DSH_INCOMPATIBLE') throw error
      return undefined
    } finally {
      await transport.close()
    }
  }

  public createTransport(endpoint: BackendEndpoint): DshTransport {
    return new LoopbackApiClient({ ...this.options, endpoint })
  }

  public createBackend(backend: ConnectedBackend): Promise<DshBackend> {
    const transport = this.createTransport(backend.endpoint)
    const interactions = new Rc6InteractionRepository(transport)
    const workspaces = new Rc6WorkspaceRepository(transport)
    const sessions = new Rc6SessionRepository(transport, workspaces)
    const jobs = new Rc6JobRepository(transport)
    const events = new DshStreamController(
      transport,
      (event) => {
        interactions.remember(event)
        sessions.remember(event)
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
      goals: new Rc6GoalRepository(transport),
      jobs,
      subagents: new Rc6SubagentRepository(transport),
      settings: new Rc6SettingsRepository(transport),
      workflows: new Rc6WorkflowRepository(transport),
      skills: new Rc6SkillRepository(transport),
      commands: new Rc6CommandRepository(transport),
      plugins: new Rc6PluginRepository(transport),
      presets: new Rc6PresetRepository(transport),
      exports: new Rc6ExportRepository(transport),
      events,
      close: async () => {
        if (closed) return
        closed = true
        await events.close()
        await transport.close()
      },
    })
  }
}
