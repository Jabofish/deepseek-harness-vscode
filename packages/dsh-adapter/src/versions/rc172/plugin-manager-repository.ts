import {
  AppError,
  type ManagedPluginEntry,
  type PluginBundleChangeResult,
  type PluginBundleFailureCode,
  type PluginBundleRepository,
  type PluginInstallCancellation,
  type PluginLocalizedText,
  type PluginManagerBundle,
  type PluginMetadata,
  type PluginRegistry,
  type PluginRegistryCatalog,
  type PluginSpecInspection,
} from '@dsh-vscode/domain'

import type { DshTransport } from '../../contracts.js'
import { unwrapRpcResultValue } from '../rc6/rpc.js'

const MANAGEMENT_ERROR_CODES = [
  'management-required',
  'unaddressable',
  'unknown-plugin',
  'invalid-spec',
  'ambiguous-install',
  'not-bundle',
  'not-removable',
  'stop-profile',
  'bundle-in-use',
  'stale-approval',
  'incompatible-version',
  'operation-error',
] as const
const INSTALL_PROBLEMS = [
  'invalid-spec',
  'already-installed',
  'not-found',
  'not-a-package',
  'not-a-bundle',
  'network',
  'unknown',
] as const
const INSTALL_KINDS = ['registry', 'path', 'git', 'tarball'] as const
const FAILURE_KINDS = [
  'pnpm-missing',
  'timeout',
  'not-found',
  'no-matching-version',
  'network',
  'disk-full',
  'permission',
  'build-blocked',
  'integrity',
  'unknown',
] as const
const APPLICATIONS = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'] as const
const READ_ONLY_REASONS = ['management-required', 'unaddressable'] as const
const FIBER_PHASES = ['pending', 'loading', 'active', 'failed', 'unloading'] as const
const MAX_BUNDLES = 5_000
const MAX_PLUGINS = 10_000

/** Exact DSH 0.1.7-rc.2 Plugin Manager Remotes, reduced to bounded safe DTOs. */
export class Rc172PluginBundleRepository implements PluginBundleRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async listBundles(signal?: AbortSignal): Promise<readonly PluginManagerBundle[]> {
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/listBundles', {}, signal),
      'pluginManager/listBundles',
    )
    if (!Array.isArray(value) || value.length > MAX_BUNDLES) throw malformed('listBundles')
    return value.map((item) => bundleInfo(item))
  }

  public async listPlugins(signal?: AbortSignal): Promise<readonly ManagedPluginEntry[]> {
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/listPlugins', {}, signal),
      'pluginManager/listPlugins',
    )
    if (!Array.isArray(value) || value.length > MAX_PLUGINS) throw malformed('listPlugins')
    return value.map((item) => managedPlugin(item))
  }

  public async registries(signal?: AbortSignal): Promise<PluginRegistryCatalog> {
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/registries', {}, signal),
      'pluginManager/registries',
    )
    const record = requiredRecord(value, 'registries result')
    if (!Array.isArray(record.fallbackRegistries) || record.fallbackRegistries.length > 64)
      throw malformed('registries result')
    const fallbackRegistries = record.fallbackRegistries.map((item) =>
      requiredRegistryUrl(item, 'fallback registry'),
    )
    const resolved =
      record.resolved === null ? null : requiredRegistryUrl(record.resolved, 'resolved registry')
    return {
      registry: requiredRegistry(record.registry, 'configured registry'),
      fallbackRegistries,
      resolved,
    }
  }

  public async inspect(
    spec: string,
    registry?: PluginRegistry,
    signal?: AbortSignal,
  ): Promise<PluginSpecInspection> {
    if (!isBoundedNonEmpty(spec, 4_096) || hasEmbeddedUrlCredentials(spec)) throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest(
        'pluginManager/inspect',
        { spec, ...(registry === undefined ? {} : { options: { registry: validateRegistry(registry) } }) },
        signal,
      ),
      'pluginManager/inspect',
    )
    return inspection(value)
  }

  public async installBundle(
    spec: string,
    options: {
      readonly requestId: string
      readonly registry?: PluginRegistry
      readonly approvedBuilds?: readonly string[]
    },
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult> {
    validateInstallInput(spec, options)
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest(
        'pluginManager/installBundle',
        {
          spec,
          options: {
            enabled: true,
            requestId: options.requestId,
            ...(options.registry === undefined ? {} : { registry: validateRegistry(options.registry) }),
            ...(options.approvedBuilds === undefined ? {} : { approvedBuilds: [...options.approvedBuilds] }),
          },
        },
        signal,
      ),
      'pluginManager/installBundle',
    )
    return installChangeResult(value, spec)
  }

  public async cancelInstall(requestId: string, signal?: AbortSignal): Promise<PluginInstallCancellation> {
    if (!isBoundedNonEmpty(requestId, 128)) throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/cancelInstall', { requestId }, signal),
      'pluginManager/cancelInstall',
    )
    const record = requiredRecord(value, 'cancelInstall result')
    if (!isOneOf(['cancelled', 'too-late', 'not-running'] as const, record.status))
      throw malformed('cancelInstall result')
    return { status: record.status }
  }

  public async waitForInstall(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult | null> {
    if (!isBoundedNonEmpty(requestId, 128)) throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/waitForInstall', { requestId }, signal),
      'pluginManager/waitForInstall',
    )
    return value === null ? null : installRecoveryResult(value)
  }

  public async removeBundle(name: string, signal?: AbortSignal): Promise<PluginBundleChangeResult> {
    if (!isBoundedNonEmpty(name, 512)) throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/removeBundle', { name }, signal),
      'pluginManager/removeBundle',
    )
    return changeResult(value, 'remove', name)
  }

  public async setPluginEnabled(
    entryId: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult> {
    if (!isBoundedNonEmpty(entryId, 512) || typeof enabled !== 'boolean') throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/setPluginEnabled', { id: entryId, enabled }, signal),
      'pluginManager/setPluginEnabled',
    )
    return changeResult(value, 'enable', entryId, enabled)
  }

  public async setBundleEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult> {
    if (!isBoundedNonEmpty(name, 512) || typeof enabled !== 'boolean') throw invalidSpec()
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/setBundleEnabled', { name, enabled }, signal),
      'pluginManager/setBundleEnabled',
    )
    return changeResult(value, 'enable', name, enabled)
  }
}

function bundleInfo(value: unknown): PluginManagerBundle {
  const record = requiredRecord(value, 'listBundles entry')
  if (
    !isBoundedNonEmpty(record.name, 512) ||
    typeof record.enabled !== 'boolean' ||
    typeof record.installed !== 'boolean' ||
    typeof record.optional !== 'boolean' ||
    typeof record.removable !== 'boolean' ||
    (record.version !== undefined && !isBoundedString(record.version, 128)) ||
    (record.description !== undefined && !isBoundedString(record.description, 4_096)) ||
    !Array.isArray(record.rows) ||
    record.rows.length > 2_000 ||
    !Array.isArray(record.overrides) ||
    record.overrides.length > 2_000
  )
    throw malformed('listBundles entry')
  const readOnlyReason = optionalOneOf(READ_ONLY_REASONS, record.readOnlyReason, 'bundle readOnlyReason')
  const errorCode =
    record.error === undefined ? undefined : readManagementErrorCode(record.error, 'bundle error')
  const meta = record.meta === undefined ? undefined : metadata(record.meta, 'bundle metadata')
  const rows = record.rows.map((item) => {
    const row = requiredRecord(item, 'bundle row')
    if (!isBoundedNonEmpty(row.rowId, 512) || !isBoundedNonEmpty(row.moduleName, 512))
      throw malformed('bundle row')
    const rowMeta = row.meta === undefined ? undefined : metadata(row.meta, 'bundle row metadata')
    if (row.entryId !== undefined && !isBoundedNonEmpty(row.entryId, 512))
      throw malformed('bundle row entry id')
    return {
      rowId: row.rowId,
      moduleName: row.moduleName,
      ...(rowMeta === undefined ? {} : { meta: rowMeta }),
      ...(row.entryId === undefined ? {} : { entryId: row.entryId }),
    }
  })
  const overrides = record.overrides.map((item) => {
    if (!isBoundedNonEmpty(item, 512)) throw malformed('bundle overrides')
    return item
  })
  return {
    name: record.name,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(meta?.title === undefined ? {} : { title: meta.title }),
    ...(meta?.description === undefined
      ? record.description === undefined
        ? {}
        : { description: record.description }
      : { description: meta.description }),
    enabled: record.enabled,
    installed: record.installed,
    optional: record.optional,
    removable: record.removable,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
    ...(errorCode === undefined ? {} : { errorCode }),
    rows,
    overrides,
  }
}

function managedPlugin(value: unknown): ManagedPluginEntry {
  const record = requiredRecord(value, 'listPlugins entry')
  if (
    !isBoundedNonEmpty(record.entryId, 512) ||
    !isBoundedNonEmpty(record.moduleName, 512) ||
    typeof record.enabled !== 'boolean' ||
    (record.fiberPhase !== null && !isOneOf(FIBER_PHASES, record.fiberPhase))
  )
    throw malformed('listPlugins entry')
  const readOnlyReason = optionalOneOf(READ_ONLY_REASONS, record.readOnlyReason, 'plugin readOnlyReason')
  const meta = record.meta === undefined ? undefined : metadata(record.meta, 'plugin metadata')
  return {
    entryId: record.entryId,
    moduleName: record.moduleName,
    ...(meta === undefined ? {} : { meta }),
    enabled: record.enabled,
    fiberPhase: record.fiberPhase,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
  }
}

function metadata(value: unknown, part: string): PluginMetadata {
  const record = requiredRecord(value, part)
  const title = record.title === undefined ? undefined : localizedText(record.title, `${part} title`)
  const description =
    record.description === undefined ? undefined : localizedText(record.description, `${part} description`)
  // Icons and metadata diagnostics are deliberately omitted: neither is needed for management and the
  // upstream values can be remote URLs or filesystem/process diagnostics.
  return { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }) }
}

function localizedText(value: unknown, part: string): PluginLocalizedText {
  if (isBoundedString(value, 4_096)) return value
  const record = requiredRecord(value, part)
  const entries = Object.entries(record)
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    typeof record.en !== 'string' ||
    !entries.every(([locale, text]) => /^[A-Za-z0-9-]{1,32}$/u.test(locale) && isBoundedString(text, 4_096))
  )
    throw malformed(part)
  return Object.fromEntries(entries) as Readonly<Record<string, string> & { en: string }>
}

function inspection(value: unknown): PluginSpecInspection {
  const record = requiredRecord(value, 'inspect result')
  if (record.status === 'refused') {
    if (!isOneOf(INSTALL_PROBLEMS, record.problem)) throw malformed('inspect refusal')
    const registries = record.registries
    if (registries !== undefined && (!Array.isArray(registries) || registries.length > 64))
      throw malformed('inspect registries')
    return {
      status: 'refused',
      problem: record.problem,
      ...(registries === undefined
        ? {}
        : { registries: registries.map((item) => requiredRegistry(item, 'inspect registry')) }),
    }
  }
  if (
    record.status !== 'accepted' ||
    !isOneOf(INSTALL_KINDS, record.kind) ||
    !(record.bundle === null || typeof record.bundle === 'boolean')
  )
    throw malformed('inspect result')
  const registry = requiredRegistry(record.registry, 'inspect registry')
  if (
    (record.name !== undefined && !isBoundedNonEmpty(record.name, 512)) ||
    (record.version !== undefined && !isBoundedString(record.version, 128)) ||
    (record.description !== undefined && !isBoundedString(record.description, 4_096)) ||
    (record.host !== undefined && !isBoundedString(record.host, 255))
  )
    throw malformed('inspect accepted result')
  return {
    status: 'accepted',
    kind: record.kind,
    bundle: record.bundle,
    registry,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.description === undefined ? {} : { description: record.description }),
    ...(record.host === undefined ? {} : { host: record.host }),
  }
}

function changeResult(
  value: unknown,
  expectedStage: 'install' | 'enable' | 'remove',
  expectedTarget: string,
  expectedEnabled?: boolean,
): PluginBundleChangeResult {
  const record = requiredRecord(value, `${expectedStage} result`)
  if (
    record.stage !== expectedStage ||
    record.target !== expectedTarget ||
    typeof record.changed !== 'boolean' ||
    !isOneOf(APPLICATIONS, record.application) ||
    (record.enabled !== undefined && typeof record.enabled !== 'boolean') ||
    (expectedEnabled !== undefined && record.enabled !== expectedEnabled) ||
    (record.bundle !== undefined && !isBoundedNonEmpty(record.bundle, 512)) ||
    (record.failedAt !== undefined && record.failedAt !== 'registry' && record.failedAt !== 'spec-host')
  )
    throw malformed(`${expectedStage} result`)
  const errorCode =
    record.error === undefined ? undefined : readManagementErrorCode(record.error, `${expectedStage} error`)
  const packageResult =
    record.packageResult === undefined ? undefined : requiredRecord(record.packageResult, 'package result')
  const failureKind =
    packageResult?.kind === undefined
      ? undefined
      : optionalOneOf(FAILURE_KINDS, packageResult.kind, 'package failure kind')
  if (
    record.pendingBuilds !== undefined &&
    (!Array.isArray(record.pendingBuilds) || record.pendingBuilds.length > 256)
  )
    throw malformed('pending build approvals')
  const pendingBuilds = (record.pendingBuilds as unknown[] | undefined)?.map((name) => {
    if (!isBoundedNonEmpty(name, 512)) throw malformed('pending build approval')
    return name
  })
  return {
    // `target` is the exact install spec and can be a local path or a private Git URL.
    // Never project it back to the Webview; callers correlate the result by request id.
    name: expectedStage === 'install' ? (record.bundle ?? 'plugin') : expectedTarget,
    changed: record.changed,
    application: record.application,
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
    stage: expectedStage,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
    ...(record.bundle === undefined ? {} : { bundle: record.bundle }),
    ...(pendingBuilds === undefined || pendingBuilds.length === 0 ? {} : { pendingBuilds }),
  }
}

function installChangeResult(value: unknown, expectedSpec: string): PluginBundleChangeResult {
  const record = requiredRecord(value, 'install result')
  if (record.stage === 'install') return changeResult(value, 'install', expectedSpec, true)

  // RC2 mutates a successful install result after pnpm completes: `target` and `stage`
  // become the installed bundle and its activation step. Preserve the call-level
  // operation as `install` for consumers, while validating the upstream target.
  if (record.stage !== 'enable' || !isBoundedNonEmpty(record.bundle, 512) || record.target !== record.bundle)
    throw malformed('install result')
  const result = changeResult(value, 'enable', record.bundle, true)
  return { ...result, stage: 'install' }
}

function installRecoveryResult(value: unknown): PluginBundleChangeResult {
  const record = requiredRecord(value, 'waitForInstall result')
  if (record.stage === 'install') {
    if (!isBoundedNonEmpty(record.target, 4_096)) throw malformed('waitForInstall result')
    return changeResult(value, 'install', record.target, true)
  }

  // The successful install mutates the active result to the bundle's enable stage.
  // `waitForInstall` has no original spec argument, so only validate the bundle target.
  if (record.stage !== 'enable' || !isBoundedNonEmpty(record.bundle, 512) || record.target !== record.bundle)
    throw malformed('waitForInstall result')
  const result = changeResult(value, 'enable', record.bundle, true)
  return { ...result, stage: 'install' }
}

function readManagementErrorCode(value: unknown, part: string): PluginBundleFailureCode {
  const error = requiredRecord(value, part)
  if (!isOneOf(MANAGEMENT_ERROR_CODES, error.code)) throw malformed(part)
  return error.code
}

function validateInstallInput(
  spec: string,
  options: {
    readonly requestId: string
    readonly registry?: PluginRegistry
    readonly approvedBuilds?: readonly string[]
  },
): void {
  if (
    !isBoundedNonEmpty(spec, 4_096) ||
    hasEmbeddedUrlCredentials(spec) ||
    !isBoundedNonEmpty(options.requestId, 128)
  )
    throw invalidSpec()
  if (options.registry !== undefined) validateRegistry(options.registry)
  if (
    options.approvedBuilds !== undefined &&
    (options.approvedBuilds.length > 256 ||
      !options.approvedBuilds.every((name) => isBoundedNonEmpty(name, 512)))
  )
    throw invalidSpec()
}

function hasEmbeddedUrlCredentials(spec: string): boolean {
  const urls = spec.match(/(?:git(?:\+[a-z]+)?|https?|ssh):\/\/[^\s]+/giu) ?? []
  return urls.some((value) => {
    try {
      const url = new URL(value)
      const ssh = url.protocol === 'ssh:' || url.protocol === 'git+ssh:'
      // DSH accepts the standard `git+ssh://git@host/repo` form. Its `git` user is a
      // transport account, not an embedded password/token; keep rejecting passwords,
      // query credentials, and userinfo on non-SSH package sources.
      return (
        url.password !== '' || url.search !== '' || (url.username !== '' && (!ssh || url.username !== 'git'))
      )
    } catch {
      return false
    }
  })
}

function requiredRegistry(value: unknown, part: string): PluginRegistry {
  return value === null ? null : requiredRegistryUrl(value, part)
}

function requiredRegistryUrl(value: unknown, part: string): string {
  if (typeof value !== 'string' || value.length > 2_048) throw malformed(part)
  try {
    const registry = validateRegistry(value)
    if (registry === null) throw malformed(part)
    return registry
  } catch {
    throw malformed(part)
  }
}

function validateRegistry(value: PluginRegistry): PluginRegistry {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 2_048) throw invalidSpec()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidSpec()
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw invalidSpec()
  return value
}

function optionalOneOf<const T extends readonly string[]>(
  allowed: T,
  value: unknown,
  part: string,
): T[number] | undefined {
  if (value === undefined) return undefined
  if (!isOneOf(allowed, value)) throw malformed(part)
  return value
}

function requiredRecord(value: unknown, part: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed(part)
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw malformed(part)
  return value as Record<string, unknown>
}

function isBoundedNonEmpty(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' && value.trim() !== '' && value.length <= max && !hasControlCharacter(value)
  )
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function invalidSpec(): AppError {
  return new AppError({
    code: 'INVALID_CONFIGURATION',
    message: 'A valid DSH plugin package specification and request identity are required.',
    retryable: false,
  })
}

function malformed(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed rc172 Plugin Manager ${part}.`,
    retryable: false,
  })
}
