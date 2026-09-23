import type { BackendCandidate, BackendCapabilities, BackendEndpoint } from '@dsh-vscode/domain'

import { normalizeDshVersion } from '../../contracts.js'
import { withExactAdapterCapabilities } from '../../compatibility.js'
import { deriveFeatureCapabilityProfile } from '../../feature-capabilities.js'
import type { VersionAdapterIdentity } from '../../adapter-base.js'
import { Alpha162VersionAdapter, type Alpha162AdapterOptions } from '../alpha162/adapter.js'
import type { AlphaLoopbackApiClientOptions } from '../alpha/transport.js'
import { callRpc } from '../rc6/rpc.js'
import { Alpha171JobRepository } from './job-repository.js'
import { Alpha171PluginRepository } from './plugin-repository.js'
import { Alpha171PresetRepository } from './preset-repository.js'
import type { AlphaLoopbackApiClient } from '../alpha/transport.js'
import { normalizeAlpha171ErrorCode } from './error-vocabulary.js'

export type Alpha171AdapterOptions = Alpha162AdapterOptions

/**
 * Adapter for the DSH 0.1.7-alpha.1 source/tag contract.
 *
 * Audited against dsh-v0.1.7-alpha.1 at
 * c36a83ff6bb95e3f82cf79f9be7c724270a8aa61. The release keeps the alpha
 * Gateway carrier but changes Session history admission to V4, removes Jobs
 * from Session Control, and exposes a standalone Job Controller stream.
 */
export class Alpha171VersionAdapter extends Alpha162VersionAdapter {
  protected override readonly identity: VersionAdapterIdentity = {
    id: 'dsh-0.1.7-alpha.1',
    supportedVersion: '0.1.7-alpha.1',
    protocolVersion: 'alpha171',
    compatibilityPriority: 210,
    fallback: false,
  }

  public override async probe(
    candidate: BackendCandidate,
    signal?: AbortSignal,
  ): Promise<BackendCapabilities | undefined> {
    const hintedVersion = normalizeDshVersion(candidate.runtimeVersion)
    if (hintedVersion !== this.supportedVersion) return undefined
    const transport = this.createTransport(candidate.endpoint)
    try {
      const sessions = await callRpc<unknown>(transport, 'session.list', {}, signal)
      const workspace = await callRpc<unknown>(transport, 'workspace.list', {}, signal)
      if (!validAlpha171SessionList(sessions) || !validAlpha171WorkspaceSnapshot(workspace)) return undefined
      const capabilities: BackendCapabilities = {
        protocolVersion: this.protocolVersion,
        dshVersion: this.supportedVersion,
        sessionRestore: true,
        jobController: true,
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
          'jobs',
        ]),
      }
      return withExactAdapterCapabilities(
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

  public override probeCompatibility(): Promise<BackendCapabilities | undefined> {
    // alpha171 is exact-only until a later source snapshot is audited.
    return Promise.resolve(undefined)
  }

  protected override createTransportOptions(endpoint: BackendEndpoint): AlphaLoopbackApiClientOptions {
    return {
      ...super.createTransportOptions(endpoint),
      sessionWireVersion: 'v4',
      controlWireVersion: 'projection-v2',
      workspaceWireVersion: 'pinned-v2',
      presetWireVersion: 'registry-v2',
      normalizeErrorCode: normalizeAlpha171ErrorCode,
    }
  }

  protected override createJobRepository(transport: AlphaLoopbackApiClient): Alpha171JobRepository {
    return new Alpha171JobRepository(transport)
  }

  protected override createPluginRepository(transport: AlphaLoopbackApiClient): Alpha171PluginRepository {
    return new Alpha171PluginRepository(transport)
  }

  protected override createPresetRepository(transport: AlphaLoopbackApiClient): Alpha171PresetRepository {
    return new Alpha171PresetRepository(transport)
  }
}

function validAlpha171SessionList(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const items = (value as { readonly items?: unknown }).items
  return (
    Array.isArray(items) &&
    items.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as { readonly agentAvailable?: unknown }).agentAvailable === 'boolean',
    )
  )
}

function validAlpha171WorkspaceSnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as {
    readonly items?: unknown
    readonly archivedSessionIds?: unknown
    readonly pinnedSessionIds?: unknown
  }
  return (
    Array.isArray(record.items) &&
    Array.isArray(record.archivedSessionIds) &&
    Array.isArray(record.pinnedSessionIds) &&
    record.archivedSessionIds.every(isNonEmptyString) &&
    record.pinnedSessionIds.every(isNonEmptyString)
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
