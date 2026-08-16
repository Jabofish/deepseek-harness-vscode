import type { DshSettingsSchema, SettingsRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'

interface Namespace {
  readonly ns: string
  readonly schema: unknown
  readonly value: unknown
  readonly applies: 'live' | 'restart'
  readonly secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[]
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
}

export class Rc6SettingsRepository implements SettingsRepository {
  private description: readonly Namespace[] | undefined
  public constructor(private readonly transport: DshTransport) {}

  public async schema(signal?: AbortSignal): Promise<DshSettingsSchema> {
    const value = await this.describe(signal)
    return {
      version: 'rc6-settings-v1',
      fields: value.namespaces.flatMap((namespace) => [
        ...namespace.secrets.map((secret) => ({
          path: `${namespace.ns}.${secret.path.join('.')}`,
          label: secret.path.at(-1) ?? namespace.ns,
          type: 'secret' as const,
          required: false,
          restartRequired: namespace.applies === 'restart',
        })),
        ...schemaFields(namespace.ns, namespace.schema, namespace.applies === 'restart'),
      ]),
    }
  }

  public async read(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
    const value = await this.describe(signal)
    return Object.fromEntries(
      value.namespaces.map((namespace) => [
        namespace.ns,
        redactNamespace(namespace.value, namespace.secrets),
      ]),
    )
  }

  public async update(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
    const [namespace, ...parts] = path.split('.')
    if (namespace === undefined || namespace === '' || parts.length === 0)
      throw new Error('Settings path must be namespace.field')
    const descriptor = await this.namespace(namespace, signal)
    if (
      value === '[configured]' &&
      descriptor.secrets.some((secret) => secret.path.join('.') === parts.join('.'))
    )
      throw new Error('Configured secrets must be changed through the credential surface.')
    const response = await callRpc<Namespace>(
      this.transport,
      'settings.mutate',
      {
        ns: namespace,
        ops: [{ op: 'set', path: parts, value }],
        expectedRevision: descriptor.revision,
      },
      signal,
    )
    this.remember(normalizeNamespace(response))
  }

  public async replace(value: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    const namespaces = Object.entries(value)
    if (namespaces.length !== 1) throw unavailable('multi-namespace settings replacement')
    const descriptors = await this.describe(signal)
    const byName = new Map(descriptors.namespaces.map((namespace) => [namespace.ns, namespace]))
    const writes = namespaces.map(([namespace, section]) => {
      const descriptor = byName.get(namespace)
      if (descriptor === undefined) throw new Error(`Unknown settings namespace ${namespace}`)
      return callRpc<Namespace>(
        this.transport,
        'settings.replace',
        {
          ns: namespace,
          section: stripSecretMarkers(asObject(section), descriptor.secrets),
          expectedRevision: descriptor.revision,
        },
        signal,
      )
    })
    const responses = await Promise.all(writes)
    for (const response of responses) this.remember(normalizeNamespace(response))
  }

  private async namespace(namespace: string, signal?: AbortSignal): Promise<Namespace> {
    const current = this.description?.find((entry) => entry.ns === namespace)
    if (current !== undefined) return current
    const described = await this.describe(signal)
    const found = described.namespaces.find((entry) => entry.ns === namespace)
    if (found === undefined) throw new Error(`Unknown settings namespace ${namespace}`)
    return found
  }

  private remember(namespace: Namespace): void {
    const current = this.description ?? []
    this.description = [...current.filter((entry) => entry.ns !== namespace.ns), namespace]
  }

  private async describe(signal?: AbortSignal): Promise<{ namespaces: Namespace[] }> {
    const value = await callRpc<{ namespaces: unknown }>(this.transport, 'settings.describe', {}, signal)
    if (!Array.isArray(value.namespaces)) throw malformedSettings()
    const namespaces = value.namespaces.map((entry) => normalizeNamespace(entry))
    this.description = namespaces
    return { namespaces: [...namespaces] }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function normalizeNamespace(value: unknown): Namespace {
  const record = asObject(value)
  const secrets = Array.isArray(record.secrets)
    ? record.secrets.flatMap((entry) => {
        const item = asObject(entry)
        const path = Array.isArray(item.path)
          ? item.path.filter((part): part is string => typeof part === 'string')
          : []
        return path.length === 0 ? [] : [{ path, set: item.set === true }]
      })
    : []
  if (
    typeof record.ns !== 'string' ||
    !Number.isInteger(record.revision) ||
    (record.applies !== 'live' && record.applies !== 'restart')
  )
    throw malformedSettings()
  const revision = record.revision as number
  return {
    ns: record.ns,
    schema: record.schema,
    value: record.value,
    applies: record.applies,
    secrets,
    revision,
    ...(record.base === undefined ? {} : { base: record.base }),
    ...(record.user === undefined ? {} : { user: record.user }),
  }
}

function malformedSettings(): Error {
  return new Error('DSH returned a malformed settings descriptor.')
}

function schemaFields(
  namespace: string,
  schema: unknown,
  restartRequired: boolean,
): DshSettingsSchema['fields'] {
  const root = asObject(schema)
  const fields: DshSettingsSchema['fields'][number][] = []
  const visit = (value: unknown, path: readonly string[]): void => {
    const record = asObject(value)
    const properties = asObject(record.properties ?? record.fields ?? record.shape)
    for (const [key, child] of Object.entries(properties)) {
      const childRecord = asObject(child)
      const next = [...path, key]
      const nested = asObject(childRecord.properties ?? childRecord.fields ?? childRecord.shape)
      if (Object.keys(nested).length > 0) visit(child, next)
      else {
        const type = schemaType(childRecord.type)
        fields.push({
          path: `${namespace}.${next.join('.')}`,
          label: key,
          type,
          required: childRecord.required === true,
          ...(Array.isArray(childRecord.enumValues)
            ? {
                enumValues: childRecord.enumValues.filter(
                  (entry): entry is string => typeof entry === 'string',
                ),
              }
            : {}),
          restartRequired,
        })
      }
    }
  }
  visit(root, [])
  return fields
}

function schemaType(value: unknown): DshSettingsSchema['fields'][number]['type'] {
  if (
    value === 'number' ||
    value === 'boolean' ||
    value === 'object' ||
    value === 'array' ||
    value === 'secret'
  )
    return value
  if (value === 'enum') return 'enum'
  return 'string'
}

function stripSecretMarkers(
  value: Record<string, unknown>,
  secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[],
): Record<string, unknown> {
  const copy = structuredClone(value)
  for (const secret of secrets) {
    let cursor = copy
    for (const part of secret.path.slice(0, -1)) {
      const next = asObject(cursor[part])
      cursor[part] = next
      cursor = next
    }
    const leaf = secret.path.at(-1)
    if (leaf !== undefined && cursor[leaf] === '[configured]') delete cursor[leaf]
  }
  return copy
}

function redactNamespace(
  value: unknown,
  secrets: readonly { readonly path: readonly string[]; readonly set: boolean }[],
): unknown {
  const copy = structuredClone(value)
  for (const secret of secrets) {
    let cursor = asObject(copy)
    for (const part of secret.path.slice(0, -1)) cursor = asObject(cursor[part])
    const leaf = secret.path.at(-1)
    if (leaf !== undefined) cursor[leaf] = secret.set ? '[configured]' : undefined
  }
  return copy
}
