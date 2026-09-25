import {
  AppError,
  type OptionalPluginBundle,
  type PluginBundleChangeResult,
  type PluginBundleFailureCode,
  type PluginBundleRepository,
  type PluginLocalizedText,
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

const CHANGE_APPLICATIONS = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled'] as const
const READ_ONLY_REASONS = ['management-required', 'unaddressable'] as const
const MAX_BUNDLES = 5_000

/** Exact DSH 0.1.7-rc.2 Plugin Manager Remotes, projected to safe profile facts. */
export class Rc172PluginBundleRepository implements PluginBundleRepository {
  public constructor(private readonly transport: DshTransport) {}

  public async listOptionalBundles(signal?: AbortSignal): Promise<readonly OptionalPluginBundle[]> {
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/listBundles', {}, signal),
      'pluginManager/listBundles',
    )
    if (!Array.isArray(value) || value.length > MAX_BUNDLES) throw malformed('listBundles')
    const optional: OptionalPluginBundle[] = []
    for (const item of value) {
      const record = requiredRecord(item, 'listBundles entry')
      if (!isNonEmptyString(record.name) || record.name.length > 512 || typeof record.optional !== 'boolean')
        throw malformed('listBundles entry')
      if (!record.optional) continue
      optional.push(toOptionalBundle(record))
    }
    return optional
  }

  public async setBundleEnabled(
    name: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<PluginBundleChangeResult> {
    if (!isNonEmptyString(name) || name.length > 512 || typeof enabled !== 'boolean')
      throw new AppError({
        code: 'INVALID_CONFIGURATION',
        message: 'A current optional DSH bundle name and enabled state are required.',
        retryable: false,
      })
    const value = unwrapRpcResultValue<unknown>(
      await this.transport.remoteRequest('pluginManager/setBundleEnabled', { name, enabled }, signal),
      'pluginManager/setBundleEnabled',
    )
    const record = requiredRecord(value, 'setBundleEnabled result')
    if (
      record.target !== name ||
      record.stage !== 'enable' ||
      typeof record.changed !== 'boolean' ||
      !isOneOf(CHANGE_APPLICATIONS, record.application) ||
      record.enabled !== enabled
    )
      throw malformed('setBundleEnabled result')
    const errorCode =
      record.error === undefined ? undefined : readManagementErrorCode(record.error, 'setBundleEnabled error')
    return {
      name,
      changed: record.changed,
      application: record.application,
      enabled,
      ...(errorCode === undefined ? {} : { errorCode }),
    }
  }
}

function toOptionalBundle(record: Record<string, unknown>): OptionalPluginBundle {
  if (
    typeof record.enabled !== 'boolean' ||
    typeof record.installed !== 'boolean' ||
    (record.version !== undefined && !isBoundedString(record.version, 128)) ||
    (record.description !== undefined && !isBoundedString(record.description, 4_096))
  )
    throw malformed('optional bundle')
  const meta = record.meta === undefined ? undefined : requiredRecord(record.meta, 'optional bundle metadata')
  const title = meta?.title === undefined ? undefined : localizedText(meta.title, 'optional bundle title')
  const metadataDescription =
    meta?.description === undefined
      ? undefined
      : localizedText(meta.description, 'optional bundle description')
  const readOnlyReason =
    record.readOnlyReason === undefined
      ? undefined
      : isOneOf(READ_ONLY_REASONS, record.readOnlyReason)
        ? record.readOnlyReason
        : (() => {
            throw malformed('optional bundle readOnlyReason')
          })()
  if (record.error !== undefined) readManagementErrorCode(record.error, 'optional bundle error')
  return {
    name: record.name as string,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(title === undefined ? {} : { title }),
    ...(metadataDescription === undefined
      ? record.description === undefined
        ? {}
        : { description: record.description }
      : { description: metadataDescription }),
    enabled: record.enabled,
    installed: record.installed,
    hasIssue: record.error !== undefined,
    ...(readOnlyReason === undefined ? {} : { readOnlyReason }),
  }
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

function readManagementErrorCode(value: unknown, part: string): PluginBundleFailureCode {
  const error = requiredRecord(value, part)
  if (!isOneOf(MANAGEMENT_ERROR_CODES, error.code)) throw malformed(part)
  // `diagnostic` can include package, profile, filesystem, or process details; never project it.
  return isBundleFailureCode(error.code) ? error.code : 'operation-error'
}

function isBundleFailureCode(value: unknown): value is PluginBundleFailureCode {
  return (
    value === 'management-required' ||
    value === 'unaddressable' ||
    value === 'unknown-plugin' ||
    value === 'not-bundle' ||
    value === 'not-removable' ||
    value === 'stop-profile' ||
    value === 'bundle-in-use' ||
    value === 'incompatible-version' ||
    value === 'operation-error'
  )
}

function requiredRecord(value: unknown, part: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed(part)
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw malformed(part)
  return value as Record<string, unknown>
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function isOneOf<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function malformed(part: string): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: `DSH returned a malformed rc172 Plugin Manager ${part}.`,
    retryable: false,
  })
}
