import { AppError } from '@dsh-vscode/domain'

/** Minimal, strict reader for the serialized Schemastery envelope used by
 * pinned rc.6 settings descriptors. It intentionally exposes raw nodes: the
 * adapter, rather than Domain or the Webview, owns this wire representation. */

export interface SerializedSchemaNode {
  readonly type: string
  readonly [key: string]: unknown
}

interface SerializedSchemaEnvelope {
  readonly uid: number
  readonly refs: Readonly<Record<string, unknown>>
}

export function schemasteryRoot(value: unknown): SerializedSchemaNode {
  const envelope = schemaEnvelope(value)
  return schemaReference(envelope, envelope.uid)
}

export function schemasteryNodeAtPath(
  value: unknown,
  path: readonly string[],
): SerializedSchemaNode | undefined {
  const envelope = schemaEnvelope(value)
  let node = schemaReference(envelope, envelope.uid)
  for (const part of path) {
    const reference =
      node.type === 'object'
        ? record(node.dict)?.[part]
        : node.type === 'dict'
          ? node.inner
          : node.type === 'array' && /^(?:0|[1-9][0-9]*)$/u.test(part)
            ? node.inner
            : undefined
    if (reference === undefined) return undefined
    node = schemaReference(envelope, reference)
  }
  return node
}

export function schemasteryObjectEntries(
  value: unknown,
): readonly (readonly [string, SerializedSchemaNode])[] {
  const envelope = schemaEnvelope(value)
  const root = schemaReference(envelope, envelope.uid)
  return objectEntries(envelope, root)
}

export function schemasteryChildEntries(
  serialized: unknown,
  node: SerializedSchemaNode,
): readonly (readonly [string, SerializedSchemaNode])[] {
  return objectEntries(schemaEnvelope(serialized), node)
}

export function schemasteryUnionMembers(
  serialized: unknown,
  node: SerializedSchemaNode,
): readonly SerializedSchemaNode[] {
  if (node.type !== 'union' || !Array.isArray(node.list)) return []
  const envelope = schemaEnvelope(serialized)
  return node.list.map((reference) => schemaReference(envelope, reference))
}

function objectEntries(
  envelope: SerializedSchemaEnvelope,
  node: SerializedSchemaNode,
): readonly (readonly [string, SerializedSchemaNode])[] {
  if (node.type !== 'object') return []
  const dict = record(node.dict)
  if (dict === undefined) throw malformedSchema()
  return Object.entries(dict).map(([key, reference]) => [key, schemaReference(envelope, reference)] as const)
}

function schemaEnvelope(value: unknown): SerializedSchemaEnvelope {
  const root = record(value)
  const refs = record(root?.refs)
  if (root === undefined || !Number.isSafeInteger(root.uid) || refs === undefined) throw malformedSchema()
  return { uid: root.uid as number, refs }
}

function schemaReference(envelope: SerializedSchemaEnvelope, reference: unknown): SerializedSchemaNode {
  if (!Number.isSafeInteger(reference)) throw malformedSchema()
  const node = record(envelope.refs[String(reference)])
  if (node === undefined || typeof node.type !== 'string' || node.type === '') throw malformedSchema()
  return node as SerializedSchemaNode
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function malformedSchema(): AppError {
  return new AppError({
    code: 'PROTOCOL_ERROR',
    message: 'DSH returned a malformed Schemastery settings schema.',
    retryable: false,
  })
}
