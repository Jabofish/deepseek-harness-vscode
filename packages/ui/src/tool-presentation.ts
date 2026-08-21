import type { ToolCallView } from '@dsh-vscode/domain'

/** Optional label translator supplied by the hosting surface (English default). */
export type PresentationTranslate = (
  key: string,
  params?: Readonly<Record<string, string | number>>,
) => string

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

/**
 * Decode JSON plus the Python/Node-style object representations emitted by
 * older tool bridges. This is a bounded, non-executable parser: tool output
 * is untrusted display data and must never be evaluated as JavaScript.
 */
export function decodeToolValue(value: string | undefined): unknown {
  return decode(value)
}

/** Format one decoded value into labeled, bounded display text. */
export function formatToolValue(value: unknown, t?: PresentationTranslate): string | undefined {
  return displayValue(value, 0, t)
}

/**
 * Format one wire text value at the final UI boundary. DSH versions and
 * bridges sometimes wrap a structured result in a short human prefix or
 * encode it more than once; neither form should leak a JSON/Python object
 * representation into the conversation.
 */
export function formatToolText(value: string | undefined, t?: PresentationTranslate): string | undefined {
  if (value === undefined) return undefined
  const source = value.trim()
  if (source === '') return undefined
  const decoded = decode(source)
  if (decoded !== source) return formatToolValue(decoded, t) ?? bounded(source)
  const embedded = embeddedStructuredLiteral(source)
  if (embedded !== undefined) {
    const parsed = decode(embedded)
    if (parsed !== embedded) {
      const prefix = source.slice(0, source.indexOf(embedded)).trim()
      const formatted = formatToolValue(parsed, t)
      if (formatted !== undefined) return prefix === '' ? formatted : `${prefix}\n${formatted}`
    }
  }
  return bounded(source)
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

/** Known field names map to a translation key plus the English fallback. */
const FIELD_LABELS: Readonly<Record<string, readonly [key: string, english: string]>> = {
  description: ['presentation.task', 'Task'],
  prompt: ['presentation.instructions', 'Instructions'],
  query: ['presentation.field.query', 'Query'],
  command: ['presentation.field.command', 'Command'],
  code: ['presentation.field.code', 'Code'],
  path: ['presentation.field.file', 'File'],
  url: ['presentation.field.url', 'URL'],
  target: ['presentation.field.target', 'Target'],
  to: ['presentation.field.target', 'Target'],
  content: ['presentation.field.content', 'Content'],
  text: ['presentation.field.text', 'Text'],
}

/** Translate when a translator is present, otherwise keep the English copy. */
function localize(
  t: PresentationTranslate | undefined,
  key: string,
  english: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return t === undefined ? english : t(key, params)
}

/**
 * Convert the adapter's bounded summaries into UI copy. This is deliberately
 * a presentation boundary: protocol envelopes and identifiers never become a
 * second, raw JSON interface inside the card.
 */
export function toolPresentation(tool: ToolCallView, t?: PresentationTranslate): ToolPresentation {
  const input = decode(tool.inputSummary)
  const output = decode(tool.outputSummary)
  const subagent = isSubagent(tool)
  const request = subagent
    ? subagentRequest(input, t)
    : detailBlocks(input, 'presentation.request', 'Request', t)
  const responseText = visibleContent(output)
  const response =
    responseText.length > 0
      ? [
          {
            label: localize(t, 'presentation.result', 'Result'),
            content: cleanAcknowledgement(responseText.join('\n\n'), subagent, t),
          },
        ]
      : detailBlocks(output, 'presentation.result', 'Result', t)
  const summary = firstString(
    field(input, 'description'),
    field(tool.metadata, 'description'),
    request[0]?.content,
  )
  const summaryText = summary === undefined ? undefined : oneLine(summary)

  return {
    title: displayTitle(tool, subagent, t),
    ...(summaryText === undefined
      ? {}
      : {
          summary: subagent
            ? localize(t, 'presentation.taskSummary', `Task · ${summaryText}`, { summary: summaryText })
            : summaryText,
        }),
    request,
    response,
  }
}

function displayTitle(tool: ToolCallView, subagent: boolean, t?: PresentationTranslate): string {
  if (subagent) return localize(t, 'presentation.subagent', 'Subagent')
  const title = tool.title.trim()
  const name = tool.name.trim()
  if (title !== '' && title.toLocaleLowerCase() !== 'tool') return title
  return name || title || localize(t, 'presentation.tool', 'Tool')
}

function isSubagent(tool: ToolCallView): boolean {
  const identity = `${tool.name} ${tool.title}`.toLocaleLowerCase()
  return /(^|[^a-z])subagent([^a-z]|$)/u.test(identity)
}

function subagentRequest(value: unknown, t?: PresentationTranslate): readonly ToolDetailBlock[] {
  const record = object(value)
  if (record === undefined) return detailBlocks(value, 'presentation.instructions', 'Instructions', t)
  const blocks: ToolDetailBlock[] = []
  const description = text(record.description)
  const prompt = text(record.prompt)
  if (description !== undefined)
    blocks.push({ label: localize(t, 'presentation.task', 'Task'), content: description })
  if (prompt !== undefined)
    blocks.push({ label: localize(t, 'presentation.instructions', 'Instructions'), content: prompt })
  const handled = new Set(['description', 'prompt'])
  for (const [key, entry] of Object.entries(record)) {
    if (handled.has(key.toLocaleLowerCase()) || isInternalField(key)) continue
    appendField(blocks, key, entry, 0, t)
  }
  return blocks
}

function detailBlocks(
  value: unknown,
  fallbackKey: string,
  fallbackEnglish: string,
  t?: PresentationTranslate,
): readonly ToolDetailBlock[] {
  if (value === undefined || value === null || value === '') return []
  const record = object(value)
  if (record === undefined) {
    const content = displayValue(value, 0, t)
    return content === undefined ? [] : [{ label: localize(t, fallbackKey, fallbackEnglish), content }]
  }
  const blocks: ToolDetailBlock[] = []
  for (const [key, entry] of Object.entries(record)) {
    if (isInternalField(key) || key.toLocaleLowerCase() === 'content') continue
    appendField(blocks, key, entry, 0, t)
  }
  const content = visibleContent(record.content)
  if (content.length > 0)
    blocks.push({ label: localize(t, fallbackKey, fallbackEnglish), content: content.join('\n\n') })
  return blocks
}

function appendField(
  blocks: ToolDetailBlock[],
  key: string,
  value: unknown,
  depth: number,
  t?: PresentationTranslate,
): void {
  if (depth > 1 || isInternalField(key)) return
  const record = object(value)
  if (record !== undefined) {
    for (const [childKey, child] of Object.entries(record)) {
      if (isInternalField(childKey)) continue
      const content = displayValue(child, 0, t)
      if (content !== undefined) blocks.push({ label: `${label(key, t)} · ${label(childKey, t)}`, content })
    }
    return
  }
  const content = displayValue(value, 0, t)
  if (content !== undefined) blocks.push({ label: label(key, t), content })
}

function visibleContent(value: unknown): readonly string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    const decoded = decode(value)
    if (decoded !== value) return visibleContent(decoded)
    const formatted = formatToolText(value)
    return formatted === undefined ? [] : [formatted]
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

function cleanAcknowledgement(value: string, subagent: boolean, t?: PresentationTranslate): string {
  if (subagent && /^started subagent(?:\s+\S+)?[.!]?$/iu.test(value.trim()))
    return localize(t, 'presentation.subagentStarted', 'Subagent started successfully.')
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
      const parsed = parseNativeLiteral(candidate)
      if (!parsed.ok) break
      current = parsed.value
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

function displayValue(value: unknown, depth = 0, t?: PresentationTranslate): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return undefined
    const decoded = decode(text)
    return decoded === text ? bounded(text) : displayValue(decoded, depth + 1, t)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (depth > 5) return '…'
    const items = value
      .slice(0, 64)
      .map((entry) => displayValue(entry, depth + 1, t))
      .filter((entry): entry is string => entry !== undefined)
    return items.length === 0 ? undefined : items.map((entry) => `• ${indent(entry)}`).join('\n')
  }
  if (value !== null && typeof value === 'object') {
    if (depth > 5) return '…'
    const lines: string[] = []
    for (const [key, entry] of Object.entries(value)) {
      if (isInternalField(key)) continue
      const content = displayValue(entry, depth + 1, t)
      if (content !== undefined) lines.push(`${label(key, t)}: ${indent(content)}`)
    }
    return lines.length === 0 ? undefined : lines.join('\n')
  }
  return undefined
}

/** Find one balanced object/array in a prefixed result without evaluating it. */
function embeddedStructuredLiteral(value: string): string | undefined {
  const start = [...value].findIndex((character) => character === '{' || character === '[')
  if (start < 0) return undefined
  const stack: string[] = []
  let quote: '"' | "'" | undefined
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== undefined) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '['
      if (stack.at(-1) !== expected) return undefined
      stack.pop()
      if (stack.length === 0) return value.slice(start, index + 1)
    }
  }
  return undefined
}

function indent(value: string): string {
  return value.replace(/\n/gu, '\n  ')
}

interface NativeLiteralState {
  readonly source: string
  index: number
  nodes: number
}

type NativeLiteralResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function parseNativeLiteral(source: string): NativeLiteralResult {
  const state: NativeLiteralState = { source, index: 0, nodes: 0 }
  const result = parseNativeValue(state, 0)
  skipWhitespace(state)
  return result.ok && state.index === source.length ? result : { ok: false }
}

function parseNativeValue(state: NativeLiteralState, depth: number): NativeLiteralResult {
  if (depth > 6 || state.nodes++ > 256) return { ok: false }
  skipWhitespace(state)
  const current = state.source[state.index]
  if (current === '{') return parseNativeObject(state, depth)
  if (current === '[') return parseNativeArray(state, depth)
  if (current === '"' || current === "'") {
    const value = parseNativeString(state)
    return value === undefined ? { ok: false } : { ok: true, value }
  }
  const rest = state.source.slice(state.index)
  const number = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/u.exec(rest)?.[0]
  if (number !== undefined) {
    state.index += number.length
    return { ok: true, value: Number(number) }
  }
  const word = /^[A-Za-z_$][A-Za-z0-9_$.-]*/u.exec(rest)?.[0]
  if (word === undefined) return { ok: false }
  state.index += word.length
  if (word === 'true' || word === 'True') return { ok: true, value: true }
  if (word === 'false' || word === 'False') return { ok: true, value: false }
  if (word === 'null' || word === 'None') return { ok: true, value: null }
  return { ok: true, value: word }
}

function parseNativeObject(state: NativeLiteralState, depth: number): NativeLiteralResult {
  state.index += 1
  const output: Record<string, unknown> = {}
  skipWhitespace(state)
  if (state.source[state.index] === '}') {
    state.index += 1
    return { ok: true, value: output }
  }
  while (state.index < state.source.length) {
    const key = parseNativeKey(state)
    if (key === undefined) return { ok: false }
    skipWhitespace(state)
    if (state.source[state.index] !== ':') return { ok: false }
    state.index += 1
    const value = parseNativeValue(state, depth + 1)
    if (!value.ok) return { ok: false }
    output[key] = value.value
    skipWhitespace(state)
    if (state.source[state.index] === '}') {
      state.index += 1
      return { ok: true, value: output }
    }
    if (state.source[state.index] !== ',') return { ok: false }
    state.index += 1
    skipWhitespace(state)
  }
  return { ok: false }
}

function parseNativeArray(state: NativeLiteralState, depth: number): NativeLiteralResult {
  state.index += 1
  const output: unknown[] = []
  skipWhitespace(state)
  if (state.source[state.index] === ']') {
    state.index += 1
    return { ok: true, value: output }
  }
  while (state.index < state.source.length) {
    const value = parseNativeValue(state, depth + 1)
    if (!value.ok) return { ok: false }
    output.push(value.value)
    skipWhitespace(state)
    if (state.source[state.index] === ']') {
      state.index += 1
      return { ok: true, value: output }
    }
    if (state.source[state.index] !== ',') return { ok: false }
    state.index += 1
    skipWhitespace(state)
  }
  return { ok: false }
}

function parseNativeKey(state: NativeLiteralState): string | undefined {
  skipWhitespace(state)
  const current = state.source[state.index]
  if (current === '"' || current === "'") return parseNativeString(state)
  const key = /^[A-Za-z_$][A-Za-z0-9_$.-]*/u.exec(state.source.slice(state.index))?.[0]
  if (key === undefined) return undefined
  state.index += key.length
  return key
}

function parseNativeString(state: NativeLiteralState): string | undefined {
  const quote = state.source[state.index]
  if (quote !== '"' && quote !== "'") return undefined
  state.index += 1
  let output = ''
  while (state.index < state.source.length) {
    const current = state.source[state.index++]
    if (current === quote) return output
    if (current !== '\\') {
      output += current
      continue
    }
    const escaped = state.source[state.index++]
    if (escaped === undefined) return undefined
    const simple: Readonly<Record<string, string>> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '\\': '\\',
      '/': '/',
      '"': '"',
      "'": "'",
    }
    if (simple[escaped] !== undefined) {
      output += simple[escaped]
      continue
    }
    if (escaped === 'u' || escaped === 'x') {
      const size = escaped === 'u' ? 4 : 2
      const hex = state.source.slice(state.index, state.index + size)
      if (!new RegExp(`^[0-9a-fA-F]{${size}}$`, 'u').test(hex)) return undefined
      output += String.fromCodePoint(Number.parseInt(hex, 16))
      state.index += size
      continue
    }
    output += escaped
  }
  return undefined
}

function skipWhitespace(state: NativeLiteralState): void {
  while (/\s/u.test(state.source[state.index] ?? '')) state.index += 1
}

function label(value: string, t?: PresentationTranslate): string {
  const normalized = value.toLocaleLowerCase()
  const known = FIELD_LABELS[normalized]
  if (known !== undefined) return localize(t, known[0], known[1])
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim()
  const sentence = spaced.toLocaleLowerCase()
  return sentence === ''
    ? localize(t, 'presentation.detail', 'Detail')
    : `${sentence[0]?.toLocaleUpperCase() ?? ''}${sentence.slice(1)}`
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
