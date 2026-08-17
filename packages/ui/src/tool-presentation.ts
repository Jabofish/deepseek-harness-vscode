import type { ToolCallView } from '@dsh-vscode/domain'

export interface ToolDetailBlock {
  readonly label: string
  readonly content: string
}

export interface ToolPresentation {
  readonly title: string
  readonly summary?: string
  readonly request: readonly ToolDetailBlock[]
  readonly response: readonly ToolDetailBlock[]
}

const INTERNAL_FIELDS = new Set([
  'source',
  'role',
  'id',
  'callid',
  'toolcallid',
  'rpcid',
  'requestid',
  'messageid',
  'sessionid',
  'parentsessionid',
  'metadata',
  'type',
  'iserror',
  'authorization',
  'token',
  'secret',
  'password',
])

const FIELD_LABELS: Readonly<Record<string, string>> = {
  description: 'Task',
  prompt: 'Instructions',
  query: 'Query',
  command: 'Command',
  code: 'Code',
  path: 'File',
  url: 'URL',
  target: 'Target',
  to: 'Target',
  content: 'Content',
  text: 'Text',
}

/**
 * Convert the adapter's bounded summaries into UI copy. This is deliberately
 * a presentation boundary: protocol envelopes and identifiers never become a
 * second, raw JSON interface inside the card.
 */
export function toolPresentation(tool: ToolCallView): ToolPresentation {
  const input = decode(tool.inputSummary)
  const output = decode(tool.outputSummary)
  const subagent = isSubagent(tool)
  const request = subagent ? subagentRequest(input) : detailBlocks(input, 'Request')
  const responseText = visibleContent(output)
  const response =
    responseText.length > 0
      ? [{ label: 'Result', content: cleanAcknowledgement(responseText.join('\n\n'), subagent) }]
      : detailBlocks(output, 'Result')
  const summary = firstString(
    field(input, 'description'),
    field(tool.metadata, 'description'),
    request[0]?.content,
  )
  const summaryText = summary === undefined ? undefined : oneLine(summary)

  return {
    title: displayTitle(tool, subagent),
    ...(summaryText === undefined ? {} : { summary: subagent ? `Task · ${summaryText}` : summaryText }),
    request,
    response,
  }
}

function displayTitle(tool: ToolCallView, subagent: boolean): string {
  if (subagent) return 'Subagent'
  const title = tool.title.trim()
  const name = tool.name.trim()
  if (title !== '' && title.toLocaleLowerCase() !== 'tool') return title
  return name || title || 'Tool'
}

function isSubagent(tool: ToolCallView): boolean {
  const identity = `${tool.name} ${tool.title}`.toLocaleLowerCase()
  return /(^|[^a-z])subagent([^a-z]|$)/u.test(identity)
}

function subagentRequest(value: unknown): readonly ToolDetailBlock[] {
  const record = object(value)
  if (record === undefined) return detailBlocks(value, 'Instructions')
  const blocks: ToolDetailBlock[] = []
  const description = text(record.description)
  const prompt = text(record.prompt)
  if (description !== undefined) blocks.push({ label: 'Task', content: description })
  if (prompt !== undefined) blocks.push({ label: 'Instructions', content: prompt })
  const handled = new Set(['description', 'prompt'])
  for (const [key, entry] of Object.entries(record)) {
    if (handled.has(key.toLocaleLowerCase()) || isInternalField(key)) continue
    appendField(blocks, key, entry, 0)
  }
  return blocks
}

function detailBlocks(value: unknown, fallbackLabel: string): readonly ToolDetailBlock[] {
  if (value === undefined || value === null || value === '') return []
  const record = object(value)
  if (record === undefined) {
    const content = displayValue(value)
    return content === undefined ? [] : [{ label: fallbackLabel, content }]
  }
  const blocks: ToolDetailBlock[] = []
  for (const [key, entry] of Object.entries(record)) {
    if (isInternalField(key) || key.toLocaleLowerCase() === 'content') continue
    appendField(blocks, key, entry, 0)
  }
  const content = visibleContent(record.content)
  if (content.length > 0) blocks.push({ label: fallbackLabel, content: content.join('\n\n') })
  return blocks
}

function appendField(blocks: ToolDetailBlock[], key: string, value: unknown, depth: number): void {
  if (depth > 1 || isInternalField(key)) return
  const record = object(value)
  if (record !== undefined) {
    for (const [childKey, child] of Object.entries(record)) {
      if (isInternalField(childKey)) continue
      const content = displayValue(child)
      if (content !== undefined) blocks.push({ label: `${label(key)} · ${label(childKey)}`, content })
    }
    return
  }
  const content = displayValue(value)
  if (content !== undefined) blocks.push({ label: label(key), content })
}

function visibleContent(value: unknown): readonly string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    const decoded = decode(value)
    return decoded === value ? (value.trim() === '' ? [] : [bounded(value)]) : visibleContent(decoded)
  }
  if (Array.isArray(value)) return unique(value.flatMap(visibleContent))
  const record = object(value)
  if (record === undefined) return []
  if (typeof record.text === 'string') return record.text.trim() === '' ? [] : [bounded(record.text)]
  for (const key of ['content', 'message', 'result', 'output'] as const) {
    const nested = visibleContent(record[key])
    if (nested.length > 0) return nested
  }
  return []
}

function cleanAcknowledgement(value: string, subagent: boolean): string {
  if (subagent && /^started subagent(?:\s+\S+)?[.!]?$/iu.test(value.trim()))
    return 'Subagent started successfully.'
  return bounded(value)
}

function decode(value: string | undefined): unknown {
  if (value === undefined) return undefined
  let current: unknown = value.trim()
  for (let depth = 0; depth < 3 && typeof current === 'string'; depth += 1) {
    const candidate = current.trim()
    if (!looksLikeJson(candidate)) break
    try {
      current = JSON.parse(candidate) as unknown
    } catch {
      break
    }
  }
  return current
}

function looksLikeJson(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('"') && value.endsWith('"'))
  )
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() === '' ? undefined : bounded(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const items = value.map(displayValue).filter((entry): entry is string => entry !== undefined)
    return items.length === 0 ? undefined : items.map((entry) => `• ${entry}`).join('\n')
  }
  return undefined
}

function label(value: string): string {
  const normalized = value.toLocaleLowerCase()
  const known = FIELD_LABELS[normalized]
  if (known !== undefined) return known
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
  const sentence = spaced.toLocaleLowerCase()
  return sentence === '' ? 'Detail' : `${sentence[0]?.toLocaleUpperCase() ?? ''}${sentence.slice(1)}`
}

function isInternalField(value: string): boolean {
  const normalized = value.replace(/[_-]/gu, '').toLocaleLowerCase()
  return INTERNAL_FIELDS.has(normalized) || normalized.startsWith('_') || normalized.endsWith('id')
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function field(value: unknown, key: string): unknown {
  return object(value)?.[key]
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? bounded(value) : undefined
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const found = text(value)
    if (found !== undefined) return found
  }
  return undefined
}

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed
}

function bounded(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 2_000 ? `${trimmed.slice(0, 1_999)}…` : trimmed
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}
