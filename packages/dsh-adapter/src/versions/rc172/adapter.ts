import type { VersionAdapterIdentity } from '../../adapter-base.js'
import type {
  BackendEndpoint,
  AccountLifecycleRepository,
  PluginBundleRepository,
  PresetRepository,
  ScheduleRepository,
} from '@dsh-vscode/domain'
import type { Rc6SessionRepositoryOptions } from '../../repositories/session-repository.js'
import type { Rc6WorkspaceRepository } from '../../repositories/workspace-repository.js'
import { Rc172SessionRepository } from './session-repository.js'

import { Rc171VersionAdapter, type Rc171AdapterOptions } from '../rc171/adapter.js'
import type { AlphaLoopbackApiClient, AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { normalizeRc172ErrorCode } from './error-vocabulary.js'
import { Rc172PresetRepository } from './preset-repository.js'
import { Rc172ScheduleRepository } from './schedule-repository.js'
import { Rc172PluginBundleRepository } from './plugin-manager-repository.js'
import { Rc172AccountLifecycleRepository } from './account-repository.js'

export type Rc172AdapterOptions = Rc171AdapterOptions

/**
 * Exact adapter for DSH 0.1.7-rc.2.
 *
 * Audited against dsh-v0.1.7-rc.2 at
 * 477b4f420553e8a52c2fbccc464d7561b239c443. The tag retains the rc.1
 * Connection/Gateway, Session V4, turn-window history, Workspace, and Job
 * contracts. Its preset registry changes the roster to `{ presets }` and
 * exposes `agentPresets.list/read/select`; that repository is isolated here.
 * The adapter is exact-only because this evidence does not establish a safe
 * compatibility profile for unknown DSH releases.
 */
export class Rc172VersionAdapter extends Rc171VersionAdapter {
  protected override readonly supportsAccountLifecycle = true
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.7-rc.2',
    supportedVersion: '0.1.7-rc.2',
    protocolVersion: 'rc172',
    compatibilityPriority: 240,
    fallback: false,
  }

  public constructor(options: Rc172AdapterOptions) {
    super(options)
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      normalizeErrorCode: normalizeRc172ErrorCode,
      // RC2's Session Controller always registers modelSelection; only an
      // explicit null/null projection means the deployment default is active.
      requireModelSelectionProjection: true,
    }
  }

  protected override createPresetRepository(transport: AlphaLoopbackApiClient): PresetRepository {
    return new Rc172PresetRepository(transport)
  }

  protected override createSessionRepository(
    transport: AlphaLoopbackApiClient,
    workspaces: Rc6WorkspaceRepository,
    options: Rc6SessionRepositoryOptions,
  ): Rc172SessionRepository {
    return new Rc172SessionRepository(transport, workspaces, this.options.samePath, options)
  }

  protected override createScheduleRepository(transport: AlphaLoopbackApiClient): ScheduleRepository {
    return new Rc172ScheduleRepository(transport)
  }

  protected override createPluginBundleRepository(transport: AlphaLoopbackApiClient): PluginBundleRepository {
    return new Rc172PluginBundleRepository(transport)
  }

  protected override createAccountLifecycleRepository(
    transport: AlphaLoopbackApiClient,
  ): AccountLifecycleRepository {
    return new Rc172AccountLifecycleRepository(transport)
  }
}
