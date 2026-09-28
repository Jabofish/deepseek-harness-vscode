import type { PresentedFileView, SubagentCatalogEntryFact, ToolCallView } from '@dsh-vscode/domain'

import { safePayload } from '../../redaction.js'
import {
  recordOrUndefined as objectOrUndefined,
  zeroBasedLine,
} from '../../repositories/shared/guards.js'
import {
  presentationDiffLocations,
  projectToolCallIntent,
  projectToolPresentation,
  projectToolResultMeta,
  projectToolShellCall,
} from '../../projection/tool-presentation.js'
import { contentText, messageText, toolResultImages } from './message-mappers.js'
import {
  bounded,
  contentEntries,
  date,
  enumValue,
  eventIndex,
  firstString,
  fullOptionalText,
  fullText,
  nonNegativeSafeNumber,
  object,
  optionalText,
  requiredArray,
  stringOr,
} from './value-guards.js'

export function tool(
  value: Record<string, unknown>,
  phase: 'call' | 'result' = 'result',
  autoReviewDenialContract = false,
): ToolCallView {
  const message = objectOrUndefined(value.message)
  const source = objectOrUndefined(message?.source)
  const isPtcDispatch = typeof value.subCallId === 'string' || typeof value.parentCallId === 'string'
  const messageIsError = value.isError === true || messageHasToolError(message)
  const viewEnvelope = objectOrUndefined(value.view)
  const view = objectOrUndefined(viewEnvelope?.view) ?? viewEnvelope
  const name = firstString(value.toolName, value.name, view?.name, view?.toolName)
  // Hosts from 0.1.2-alpha.1 on send no view: the tool's own `meta` payload is
  // the card. A settled failure carries no fresh projection, so metadata that
  // rode along with one never becomes a card either.
  const presentation =
    projectToolPresentation(viewEnvelope, phase, contentText) ??
    projectToolResultMeta(phase === 'result' && !messageIsError ? value.meta : undefined, contentText) ??
    // The call side of the same change: a pinned host projected the intended
    // file mutation through its tool definition, and a host without the
    // envelope has to state it from the call's own arguments. A subcall of a
    // code-dispatch tree is presented flattened, as the reference models do.
    (phase === 'call' && !isPtcDispatch ? projectToolCallIntent(name, value.arguments) : undefined) ??
    // The running command of a shell call, which the same hosts used to project
    // through `presentCall`; the reference terminal model draws it for nested
    // dispatch calls too, so this one is not gated on the tree.
    (phase === 'call' ? projectToolShellCall(name, value.arguments) : undefined)
  const error = objectOrUndefined(value.error)
  const input =
    value.inputSummary ??
    value.arguments ??
    view?.inputSummary ??
    view?.rawInput ??
    view?.description ??
    view?.content
  const messageOutput =
    message === undefined
      ? isPtcDispatch && Array.isArray(value.content)
        ? contentText(value.content, false)
        : undefined
      : messageText(message)
  const messageError = message === undefined ? '' : messageToolErrorText(message)
  const output =
    value.outputSummary ??
    messageOutput ??
    view?.outputSummary ??
    view?.rawOutput ??
    view?.output ??
    view?.content
  const errorText = toolErrorText(value.error, error, messageIsError, messageError, messageOutput)
  const mappedStatus = enumValue(
    value.status,
    ['queued', 'running', 'completed', 'failed', 'cancelled'] as const,
    message === undefined ? 'running' : errorText !== undefined || messageIsError ? 'failed' : 'completed',
  )
  const title = firstString(value.title, view?.title, name)
  const derivedCategory =
    presentation?.phase === 'result' && presentation.card === 'diff' ? 'diff' : undefined
  const category = firstString(value.category, view?.category, view?.kind, view?.card, derivedCategory)
  const locations =
    toolLocations(value.locations ?? view?.locations) ?? presentationDiffLocations(presentation)
  const status =
    (errorText !== undefined || messageIsError) && mappedStatus !== 'cancelled' ? 'failed' : mappedStatus
  const turn = eventIndex(value.turn)
  const step = eventIndex(value.step)
  const parentCallId = firstString(value.parentCallId)
  const callId = stringOr(
    value.callId ?? source?.callId ?? value.subCallId ?? value.id ?? view?.callId ?? view?.id,
    'tool-call',
  )
  const autoReviewDenial = autoReviewDenialContract
    ? toolAutoReviewDenial(value.error, message, callId, phase)
    : undefined
  const images =
    phase === 'result' ? toolResultImages(message, isPtcDispatch ? value.content : undefined, callId) : []
  const submittedPlan = readSubmittedPlan(name, value.arguments)
  return {
    id: callId,
    ...(submittedPlan === undefined ? {} : { submittedPlan }),
    ...(images.length === 0 ? {} : { images }),
    ...(parentCallId === undefined ? {} : { parentCallId }),
    ...(turn === undefined ? {} : { turn }),
    ...(step === undefined ? {} : { step }),
    name: name ?? 'unknown-tool',
    category: category ?? 'tool',
    title: title ?? 'Tool',
    status,
    ...(value.startedAt === undefined ? {} : { startedAt: date(value.startedAt) }),
    ...(value.completedAt === undefined ? {} : { completedAt: date(value.completedAt) }),
    ...(input === undefined ? {} : { inputSummary: fullText(input) }),
    ...(output === undefined ? {} : { outputSummary: fullText(output) }),
    ...(errorText === undefined || errorText === '' ? {} : { error: errorText }),
    ...(autoReviewDenial === undefined ? {} : { autoReviewDenial }),
    ...(locations === undefined ? {} : { locations }),
    ...(presentation === undefined ? {} : { presentation }),
    metadata: objectOrUndefined(safePayload(view)) ?? {},
  }
}

/**
 * DSH persists a tool failure as a small identity object and keeps the
 * human-readable text in the error-marked tool-result message. Prefer that
 * replay-authoritative text; then use the upstream user-facing reason before
 * falling back to a single identity field so `{name, code}` never becomes a
 * misleading JSON sentence in the timeline.
 */
function readSubmittedPlan(name: string | undefined, argumentsValue: unknown): ToolCallView['submittedPlan'] {
  if (name !== 'exit_plan_mode') return undefined
  let args: unknown = argumentsValue
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args) as unknown
    } catch {
      return undefined
    }
  }
  const plan = objectOrUndefined(args)?.plan
  if (typeof plan !== 'string' || plan.length > 1_000_000) return undefined
  const title = /^#\s+(\S[^\r\n]*)/u.exec(plan.trim())?.[1]
  return title === undefined ? undefined : { title, markdown: plan }
}

function toolErrorText(
  value: unknown,
  identity: Record<string, unknown> | undefined,
  messageIsError: boolean,
  messageError: string,
  messageOutput: string | undefined,
): string | undefined {
  if (value !== undefined) {
    const explicit = typeof value === 'string' ? value : identity?.message
    const explicitText = fullOptionalText(explicit)
    if (explicitText !== undefined) return explicitText
    if (messageIsError) {
      const messageTextValue = fullOptionalText(messageError) ?? fullOptionalText(messageOutput)
      // An empty upstream tool-result block is rendered by contentText as a
      // structural placeholder; the alpha.1 error.reason is more useful.
      if (messageTextValue !== undefined && messageTextValue !== '[tool result]') return messageTextValue
    }
    const identityText =
      fullOptionalText(identity?.reason) ?? optionalText(identity?.code) ?? optionalText(identity?.name)
    if (identityText !== undefined) return identityText
    if (typeof value === 'number' || typeof value === 'boolean') return bounded(value)
    return undefined
  }
  if (!messageIsError) return undefined
  return fullOptionalText(messageError) ?? fullOptionalText(messageOutput)
}

function toolLocations(
  value: unknown,
): readonly { readonly path: string; readonly line?: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const locations: { path: string; line?: number }[] = []
  for (const entry of value) {
    const record = objectOrUndefined(entry)
    const path = record?.path
    if (
      typeof path !== 'string' ||
      path.trim() === '' ||
      path.length > 4_096 ||
      hasUnsafePathCharacters(path) ||
      seen.has(path)
    )
      continue
    seen.add(path)
    const line = zeroBasedLine(record?.line)
    locations.push({ path, ...(line === undefined ? {} : { line }) })
    if (locations.length >= 32) break
  }
  return locations.length === 0 ? undefined : locations
}

/** Map the explicit DSH file-delivery payload without exposing arbitrary JSON. */
export function presentedFiles(value: unknown): readonly PresentedFileView[] {
  const entries = requiredArray(value, 'deliverables/presented files')
  if (entries.length === 0 || entries.length > 128)
    throw new Error('Malformed deliverables/presented files count')
  return entries.map((entry) => {
    const file = object(entry, 'deliverables/presented file')
    const path = safePresentedPath(file.path)
    const description = safePresentedDescription(file.description)
    return { path, ...(description === undefined ? {} : { description }) }
  })
}

function safePresentedPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 4_096 ||
    hasUnsafePathCharacters(value)
  )
    throw new Error('Malformed deliverables/presented path')
  return value
}

function safePresentedDescription(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('Malformed deliverables/presented description')
  const description = displayLine(value)
  return description === '' ? undefined : description
}

export function safeStableIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 512 ||
    hasUnsafePathCharacters(value)
  )
    throw new Error(`Malformed ${label}`)
  return value
}

export function subagentCatalogEntry(data: Record<string, unknown>): SubagentCatalogEntryFact {
  if (data.version !== 0) throw new Error('Malformed subagent/catalog version')
  const id = safeStableIdentifier(data.childId, 'subagent/catalog childId')
  const createdAt = nonNegativeSafeNumber(data.childCreatedAt)
  if (createdAt === undefined) throw new Error('Malformed subagent/catalog childCreatedAt')
  if (data.mode !== 'one-shot' && data.mode !== 'continuable')
    throw new Error('Malformed subagent/catalog mode')
  const hasLabel = Object.hasOwn(data, 'label')
  if (!hasLabel && data.mode === 'continuable')
    throw new Error('Malformed subagent/catalog continuable label')
  const label = hasLabel ? safeCatalogLabel(data.label) : undefined
  return {
    id,
    createdAt,
    mode: data.mode,
    ...(label === undefined ? {} : { label }),
  }
}

function safeCatalogLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') throw new Error('Malformed subagent/catalog label')
  const label = displayLine(value)
  return label === '' ? undefined : label
}

/**
 * Project model-authored display text as one bounded line.
 *
 * DSH types a `present` file `description` and a `subagent` label as plain
 * strings, so a line break or tab is a valid fact. They render as single-line
 * labels, so a control character collapses to a space: refusing the value
 * would degrade the whole durable record — and the product surface it carries —
 * into an unreadable frame.
 */
function displayLine(value: string): string {
  let text = ''
  let pendingSpace = false
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      pendingSpace = text !== ''
      continue
    }
    if (pendingSpace) {
      text += ' '
      pendingSpace = false
    }
    text += character
  }
  return text.trim().slice(0, 4_096)
}

function hasUnsafePathCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f)
  })
}

function messageHasToolError(value: Record<string, unknown> | undefined): boolean {
  if (value?.isError === true) return true
  return contentEntries(value?.content).some((entry) => {
    const block = objectOrUndefined(entry)
    return block?.type === 'tool-result' && block.isError === true
  })
}

/**
 * Keep the pinned DSH denial identity only from the matching, error-marked
 * result block. Tool error prose is deliberately not inspected for markers.
 */
function toolAutoReviewDenial(
  errorValue: unknown,
  message: Record<string, unknown> | undefined,
  callId: string,
  phase: 'call' | 'result',
): { readonly reason?: string } | undefined {
  if (phase !== 'result') return undefined
  const result = contentEntries(message?.content)
    .map((entry) => objectOrUndefined(entry))
    .find((block) => block?.type === 'tool-result' && block.toolCallId === callId && block.isError === true)
  if (result === undefined) return undefined
  // RC2 Session V4 stores this identity on the `tool/result` event data. The
  // message block supplies the corresponding error verdict and call identity.
  const error = objectOrUndefined(errorValue)
  if (error?.name !== 'AutoReviewDeniedError' || error.code !== 'AUTO_REVIEW_DENIED') return undefined
  return typeof error.reason === 'string' ? { reason: error.reason } : {}
}

function messageToolErrorText(value: Record<string, unknown>): string {
  const errorBlock = contentEntries(value.content)
    .map((entry) => objectOrUndefined(entry))
    .find((block) => block?.type === 'tool-result' && block.isError === true)
  if (errorBlock !== undefined) {
    const content = contentText(contentEntries(errorBlock.content), false)
    if (content !== '') return content
    const direct = stringOr(errorBlock.text ?? errorBlock.message, '')
    if (direct !== '') return direct
  }
  return messageText(value)
}
