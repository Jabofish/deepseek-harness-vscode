import type { TimelineNode } from '@dsh-vscode/timeline'

export interface InspectorRecord {
  readonly id: string
  readonly source: 'events' | 'nodes'
  readonly type: string
  readonly sequence?: number
  readonly nodeId?: string
  readonly fields: Readonly<Record<string, Readonly<Record<string, number | boolean>>>>
}
function counts(value: unknown, keys: readonly string[]): Record<string, number | boolean> {
  const result: Record<string, number | boolean> = {}
  if (typeof value !== 'object' || value === null) return result
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const count = record[key]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0 && count <= Number.MAX_SAFE_INTEGER)
      result[key] = count
    if (typeof count === 'boolean') result[key] = count
  }
  return result
}
const COORDINATES = ['turn', 'step', 'attempt', 'sequence', 'durationMs'] as const
export function inspectChatNode(node: TimelineNode, index: number): InspectorRecord {
  const structure: Record<string, number | boolean> = { index }
  if ('markdown' in node) structure.textCharacters = node.markdown.length
  if ('streaming' in node) structure.streaming = node.streaming
  if ('images' in node) structure.images = node.images?.length ?? 0
  if ('attachments' in node) structure.attachments = node.attachments?.length ?? 0
  if (node.kind === 'tool')
    structure.settled = node.tool.status === 'completed' || node.tool.status === 'failed'
  if (node.kind === 'deliverables') structure.files = node.files.length
  if (node.kind === 'goal') structure.items = node.goals.length
  if (node.kind === 'todo') structure.items = node.todos.length
  if (node.kind === 'assistant-message' && node.reasoning !== undefined)
    structure.reasoningCharacters = node.reasoning.markdown.length
  const sequence = 'sequence' in node && typeof node.sequence === 'number' ? node.sequence : undefined
  return {
    id: `node:${node.id}`,
    source: 'nodes',
    nodeId: node.id,
    type: node.kind,
    ...(sequence === undefined ? {} : { sequence }),
    fields: {
      coordinates: counts(node, COORDINATES),
      structure,
      ...(node.kind === 'assistant-message' && node.usage !== undefined
        ? {
            usage: counts(node.usage, [
              'inputTokens',
              'outputTokens',
              'totalTokens',
              'cacheReadTokens',
              'cacheWriteTokens',
            ]),
          }
        : {}),
    },
  }
}
