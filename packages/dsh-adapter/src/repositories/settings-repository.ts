import { AppError, type DshSettingsSchema, type SettingsRepository } from '@dsh-vscode/domain'

import type { DshTransport } from '../contracts.js'
import { callRpc, unavailable } from '../versions/rc6/rpc.js'
import {
  schemasteryChildEntries,
  schemasteryObjectEntries,
  schemasteryUnionMembers,
  type SerializedSchemaNode,
} from '../versions/rc6/schemastery.js'

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

interface SettingsDescription {
  readonly writable: boolean
  readonly hasDocument: boolean
  readonly namespaces: readonly Namespace[]
}

export class Rc6SettingsRepository implements SettingsRepository {
  private description: SettingsDescription | undefined
  public constructor(private readonly transport: DshTransport) {}

  public async schema(signal?: AbortSignal): Promise<DshSettingsSchema> {
    const value = await this.describe(signal)
    return {
      version: 'rc6-settings-v2',
      writable: value.writable,
      hasDocument: value.hasDocument,
      fields: value.namespaces.flatMap((namespace) => {
        // The secret view is authoritative for its paths; the same field in
        // the JSON schema would only duplicate the row.
        const secretPaths = new Set(namespace.secrets.map((secret) => secret.path.join('.')))
        const prefixLength = namespace.ns.length + 1
        return [
          ...namespace.secrets.map((secret) => ({
            path: `${namespace.ns}.${secret.path.join('.')}`,
            label: secret.path.at(-1) ?? namespace.ns,
            type: 'secret' as const,
            required: false,
            restartRequired: namespace.applies === 'restart',
          })),
          ...schemaFields(namespace.ns, namespace.schema, namespace.applies === 'restart').filter(
            (field) => !secretPaths.has(field.path.slice(prefixLength)),
          ),
        ]
      }),
      namespaces: value.namespaces.map((namespace) => ({
        ns: namespace.ns,
        applies: namespace.applies,
        userFields: Object.keys(asObject(namespace.user)),
        secrets: namespace.secrets.map((secret) => ({
          field: secret.path.join('.'),
          set: secret.set,
        })),
      })),
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
    this.requireWritable()
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

  public async unset(path: string, signal?: AbortSignal): Promise<void> {
    const [namespace, ...parts] = path.split('.')
    if (namespace === undefined || namespace === '' || parts.length === 0)
      throw new Error('Settings path must be namespace.field')
    const descriptor = await this.namespace(namespace, signal)
    this.requireWritable()
    const response = await callRpc<Namespace>(
      this.transport,
      'settings.mutate',
      {
        ns: namespace,
        ops: [{ op: 'unset', path: parts }],
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
    this.requireWritable()
    const byName = new Map(descriptors.namespaces.map((namespace) => [namespace.ns, namespace]))
    const writes = namespaces.map(([namespace, section]) => {
      const descriptor = byName.get(namespace)
      if (descriptor === undefined) throw new Error(`Unknown settings namespace ${namespace}`)
      if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        throw new AppError({
          code: 'INVALID_CONFIGURATION',
          message: `Settings namespace ${namespace} must be an object.`,
          retryable: false,
        })
      }
      return callRpc<Namespace>(
        this.transport,
        'settings.replace',
        {
          ns: namespace,
          section: stripSecretMarkers(section as Record<string, unknown>, descriptor.secrets),
          expectedRevision: descriptor.revision,
        },
        signal,
      )
    })
    const responses = await Promise.all(writes)
    for (const response of responses) this.remember(normalizeNamespace(response))
  }

  private async namespace(namespace: string, signal?: AbortSignal): Promise<Namespace> {
    const current = this.description?.namespaces.find((entry) => entry.ns === namespace)
    if (current !== undefined) return current
    const described = await this.describe(signal)
    const found = described.namespaces.find((entry) => entry.ns === namespace)
    if (found === undefined) throw new Error(`Unknown settings namespace ${namespace}`)
    return found
  }

  private remember(namespace: Namespace): void {
    if (this.description === undefined) return
    this.description = {
      ...this.description,
      namespaces: [...this.description.namespaces.filter((entry) => entry.ns !== namespace.ns), namespace],
    }
  }

  private async describe(signal?: AbortSignal): Promise<SettingsDescription> {
    const value = recordOrUndefined(await callRpc<unknown>(this.transport, 'settings.describe', {}, signal))
    if (
      value === undefined ||
      typeof value.writable !== 'boolean' ||
      typeof value.hasDocument !== 'boolean' ||
      !Array.isArray(value.namespaces)
    )
      throw malformedSettings()
    const namespaces = value.namespaces.map((entry) => normalizeNamespace(entry))
    this.description = {
      writable: value.writable,
      hasDocument: value.hasDocument,
      namespaces,
    }
    return { ...this.description, namespaces: [...namespaces] }
  }

  private requireWritable(): void {
    if (this.description?.writable !== false) return
    throw new AppError({
      code: 'PERMISSION_DENIED',
      message: 'The DSH settings provider is read-only.',
      retryable: false,
    })
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeNamespace(value: unknown): Namespace {
  const record = recordOrUndefined(value)
  if (
    record === undefined ||
    !Object.prototype.hasOwnProperty.call(record, 'schema') ||
    !Object.prototype.hasOwnProperty.call(record, 'value') ||
    !Array.isArray(record.secrets)
  )
    throw malformedSettings()
  const secrets = record.secrets.map((entry) => {
    const item = asObject(entry)
    if (
      !Array.isArray(item.path) ||
      item.path.length === 0 ||
      !item.path.every((part): part is string => typeof part === 'string' && part !== '') ||
      typeof item.set !== 'boolean'
    )
      throw malformedSettings()
    return { path: item.path, set: item.set }
  })
  if (
    typeof record.ns !== 'string' ||
    record.ns === '' ||
    record.schema === undefined ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 0 ||
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

function malformedSettings(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed settings descriptor.',
    retryable: false,
  })
}

function schemaFields(
  namespace: string,
  schema: unknown,
  restartRequired: boolean,
): DshSettingsSchema['fields'] {
  const fields: DshSettingsSchema['fields'][number][] = []
  const visit = (
    entries: readonly (readonly [string, SerializedSchemaNode])[],
    path: readonly string[],
  ): void => {
    for (const [key, child] of entries) {
      const next = [...path, key]
      const nested = schemasteryChildEntries(schema, child)
      if (nested.length > 0) visit(nested, next)
      else {
        const description = asObject(child.meta).description
        const enumValues = schemaEnumValues(schema, child)
        fields.push({
          path: `${namespace}.${next.join('.')}`,
          label: typeof description === 'string' && description !== '' ? description : key,
          type: enumValues === undefined ? schemaType(child.type) : 'enum',
          required: asObject(child.meta).required === true,
          ...(enumValues === undefined ? {} : { enumValues }),
          restartRequired,
        })
      }
    }
  }
  visit(schemasteryObjectEntries(schema), [])
  return fields
}

function schemaEnumValues(schema: unknown, node: SerializedSchemaNode): readonly string[] | undefined {
  const members = node.type === 'const' ? [node] : schemasteryUnionMembers(schema, node)
  if (members.length === 0) return undefined
  const values = members.map((member) => member.value)
  return values.every((value): value is string => typeof value === 'string') ? values : undefined
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
