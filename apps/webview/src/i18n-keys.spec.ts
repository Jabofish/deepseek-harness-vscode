// @vitest-environment node

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  changeSummarySchema,
  checkpointSummarySchema,
  promptTemplateSummarySchema,
  taskSummarySchema,
} from '@dsh-vscode/webview-protocol'
import type {
  BackendState,
  DiagnosticsSnapshot,
  GoalView,
  JobView,
  PermissionRequest,
  PluginFiberPhase,
  SessionExportOptions,
  SessionStatus,
  TeamMemberPhase,
  TeamTaskStatus,
  TodoView,
  WorkflowMember,
  WorkflowSummary,
} from '@dsh-vscode/domain'
import type { FeedbackCategory, RunningInputMode, SubagentDiagnosticView } from '@dsh-vscode/domain'
import { PROMPT_MODES } from '@dsh-vscode/domain'
import { CONVERSATION_FONT_SIZE_OPTIONS, THEME_PREFERENCE_OPTIONS } from './app/ui-preferences.js'
import type { RuntimeConnectionStage } from './features/runtime/RuntimeConnectionView.js'
import type { PresetCopyBlocker } from './features/settings/PresetManager.js'
import type { Locale } from './i18n.js'
import { translate } from './i18n.js'

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * Value sets behind `t(\`prefix.${value}\`)` templates. The `Record<Union, true>`
 * annotations are the exhaustiveness guard: adding a member to one of these
 * unions stops `pnpm typecheck` here until the family list below covers it.
 */
const GOAL_STATUS: Record<GoalView['status'], true> = {
  pending: true,
  'in-progress': true,
  completed: true,
  blocked: true,
}
const TODO_STATUS: Record<TodoView['status'], true> = {
  pending: true,
  'in-progress': true,
  completed: true,
}
const JOB_STATUS: Record<JobView['status'], true> = {
  running: true,
  stopping: true,
  completed: true,
  failed: true,
  killed: true,
}
type WorkflowStatus = WorkflowSummary['status']
/**
 * The run row and its member rows render through the same `workflow.status.`
 * family, so a status only one of the unions knows would print its raw key.
 * The pin fails `pnpm typecheck` when the two unions drift apart.
 */
const WORKFLOW_MEMBER_STATUS_PINNED: [WorkflowStatus] extends [WorkflowMember['status']]
  ? [WorkflowMember['status']] extends [WorkflowStatus]
    ? true
    : never
  : never = true
const WORKFLOW_STATUS: Record<WorkflowStatus, true> = {
  running: true,
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
}
const SESSION_STATUS: Record<SessionStatus, true> = {
  idle: true,
  running: true,
  'awaiting-input': true,
  failed: true,
  completed: true,
}
const PLUGIN_PHASE: Record<Exclude<PluginFiberPhase, null>, true> = {
  pending: true,
  loading: true,
  active: true,
  failed: true,
  unloading: true,
}
const APPROVAL_RISK: Record<PermissionRequest['risk'], true> = {
  unknown: true,
  low: true,
  medium: true,
  high: true,
}
const EXPORT_FORMAT: Record<SessionExportOptions['format'], true> = {
  markdown: true,
  json: true,
  zip: true,
}
const DIAGNOSTICS_STATE: Record<BackendState['kind'], true> = {
  idle: true,
  'locating-runtime': true,
  discovering: true,
  connecting: true,
  connected: true,
  starting: true,
  'runtime-missing': true,
  failed: true,
  'port-conflict': true,
  stopping: true,
}
const DIAGNOSTICS_ENDPOINT: Record<Exclude<DiagnosticsSnapshot['endpointKind'], undefined>, true> = {
  configured: true,
  external: true,
  managed: true,
}
const FEEDBACK_CATEGORY: Record<FeedbackCategory, true> = {
  'task-result': true,
  'instruction-following': true,
  'product-interaction': true,
  'service-stability': true,
  'resource-cost': true,
  'security-privacy-permission': true,
  other: true,
}
const SUBAGENT_DIAGNOSTIC_REASON: Record<SubagentDiagnosticView['reason'], true> = {
  corrupt: true,
  unsupported: true,
  unavailable: true,
}
const RUNTIME_CONNECTION_STAGE: Record<RuntimeConnectionStage, true> = {
  discovering: true,
  'locating-runtime': true,
  starting: true,
  connecting: true,
  sessions: true,
}
const PRESET_COPY_BLOCKER: Record<PresetCopyBlocker, true> = {
  idRequired: true,
  idInvalid: true,
  idTaken: true,
}
/**
 * The Agent Team pill renders one `timeline.teamStatus.` key built from three
 * different wire unions, so every member of each one needs a label: a phase or
 * status the dictionary does not know prints its raw value into the card.
 */
const TEAM_STATUS_VALUE: Record<TeamMemberPhase | TeamTaskStatus | 'queued' | 'delivered', true> = {
  provisioning: true,
  active: true,
  failed: true,
  pending: true,
  in_progress: true,
  completed: true,
  deleted: true,
  queued: true,
  delivered: true,
}
const TEAM_DELIVERY_MODE: Record<'quiet' | 'wakeup', true> = {
  quiet: true,
  wakeup: true,
}
/**
 * The `settings.value.` family is fed by several option sets; the ones with an
 * exported list are read from there in the family below, and the rest are
 * pinned here. Only three permission presets need labels: `SessionControls`
 * de-kebabes any other deployment-defined id instead of building a key.
 */
const SETTINGS_VALUE: Record<
  Locale | RunningInputMode | 'danger-full-access' | 'workspace-write' | 'read-only',
  true
> = {
  en: true,
  zh: true,
  queue: true,
  steer: true,
  'danger-full-access': true,
  'workspace-write': true,
  'read-only': true,
}
/** Kinds `RuntimeStatus` renders through the template; the rest are mapped first. */
const RUNTIME_STATUS_TEMPLATE: Record<
  Exclude<BackendState['kind'], 'connected' | 'runtime-missing' | 'failed' | 'port-conflict'>,
  true
> = {
  idle: true,
  'locating-runtime': true,
  discovering: true,
  connecting: true,
  starting: true,
  stopping: true,
}

/** Matches the key tables components carry (`{ labelKey: 'settings.x' }`). */
const KEY_TABLE_FIELDS = /\b(?:labelKey|hintKey|titleKey|descriptionKey|translationKey)\s*:\s*'([^'\\]+)'/gu

function sourceFiles(directory: string): readonly string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.tsx?$/u.test(entry.name) && !/\.spec\.tsx?$/u.test(entry.name)) files.push(path)
  }
  return files
}

/**
 * Literal keys only: `t('a.b')` / `translate('a.b')`. Keys assembled at runtime
 * (`t(statusKey(state))`) cannot be checked statically and are skipped.
 */
function literalKeys(source: string): readonly string[] {
  const keys: string[] = []
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([^'\\]+)'/gu)) {
    if (match[1] !== undefined) keys.push(match[1])
  }
  return keys
}

/** Text of a call's argument list, ending at the `)` that closes the call. */
function argumentList(source: string, start: number): string {
  let depth = 0
  let quote: string | undefined
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== undefined) {
      if (character === '\\') index += 1
      else if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === '`') quote = character
    else if (character === '(') depth += 1
    else if (character === ')') {
      if (depth === 0) return source.slice(start, index)
      depth -= 1
    }
  }
  return source.slice(start)
}

/** Literal call sites paired with the raw text of their arguments. */
function callSites(source: string): readonly { readonly key: string; readonly args: string }[] {
  const sites: { key: string; args: string }[] = []
  for (const match of source.matchAll(/\b(?:t|translate)\(\s*'([^'\\]+)'/gu)) {
    if (match[1] === undefined || match.index === undefined) continue
    sites.push({ key: match[1], args: argumentList(source, match.index + match[0].length) })
  }
  return sites
}

/** Object literal members at the top level, honouring strings and nesting. */
function members(literal: string): readonly string[] {
  const body = literal.slice(1, -1)
  const found: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined
  for (const character of body) {
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    else if (character === ')' || character === ']' || character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      found.push(current)
      current = ''
      continue
    }
    current += character
  }
  found.push(current)
  return found.map((member) => member.trim()).filter((member) => member !== '')
}

/**
 * Names a literal params object supplies, or `undefined` when the shape cannot
 * be read statically (spread, computed keys, a variable instead of an object).
 */
function suppliedNames(args: string): readonly string[] | undefined {
  const object = args.replace(/^\s*,/u, '').trimStart()
  if (!object.startsWith('{')) return undefined
  let depth = 0
  let close = -1
  for (let index = 0; index < object.length; index += 1) {
    if (object[index] === '{') depth += 1
    else if (object[index] === '}') {
      depth -= 1
      if (depth === 0) {
        close = index
        break
      }
    }
  }
  if (close === -1) return undefined
  const names: string[] = []
  for (const member of members(object.slice(0, close + 1))) {
    if (member.startsWith('...')) return undefined
    const colon = member.search(/:(?!:)/u)
    const head = (colon === -1 ? member : member.slice(0, colon)).trim().replace(/^['"]|['"]$/gu, '')
    if (!/^[A-Za-z_$][\w$]*$/u.test(head)) return undefined
    names.push(head)
  }
  return names
}

/** One `en: {` / `zh: {` dictionary literal mapped from key to its raw value text. */
function dictionaryEntries(source: string, locale: string): ReadonlyMap<string, string> {
  const start = source.indexOf(`\n  ${locale}: {`)
  if (start < 0) throw new Error(`dictionary ${locale} not found`)
  const lines = source.slice(source.indexOf('{', start) + 1).split('\n')
  const entries = new Map<string, string>()
  let key: string | undefined
  for (const line of lines) {
    if (/^ {2}\},?$/u.test(line)) break
    const opened = /^ {4}'([^']+)':(.*)$/u.exec(line)
    if (opened !== null && opened[1] !== undefined) {
      key = opened[1]
      entries.set(key, opened[2] ?? '')
      continue
    }
    if (key !== undefined) entries.set(key, `${entries.get(key) ?? ''} ${line.trim()}`)
  }
  return entries
}

function placeholders(value: string): readonly string[] {
  return [...value.matchAll(/\{(\w+)\}/gu)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort()
}

describe('webview translation keys', () => {
  it('keeps both dictionaries at parity, so a non-English UI is never half-translated', () => {
    // The provider is `zh[key] ?? en[key] ?? key`: a key missing from `zh` is not
    // an exception, it is an English string rendered into a Chinese interface,
    // and a placeholder named differently between the two leaves literal braces.
    const source = readFileSync(fileURLToPath(new URL('./i18n.tsx', import.meta.url)), 'utf8')
    const english = dictionaryEntries(source, 'en')
    const chinese = dictionaryEntries(source, 'zh')

    expect(english.size).toBeGreaterThan(1_000)
    expect([...english.keys()].filter((key) => !chinese.has(key))).toEqual([])
    expect([...chinese.keys()].filter((key) => !english.has(key))).toEqual([])
    const drifted = [...english.entries()]
      .filter(
        ([key, value]) => placeholders(value).join(',') !== placeholders(chinese.get(key) ?? '').join(','),
      )
      .map(
        ([key, value]) =>
          `${key}: en{${placeholders(value).join(',')}} zh{${placeholders(chinese.get(key) ?? '').join(',')}}`,
      )
    expect(drifted).toEqual([])
  })

  it('defines every literal translation key an English UI can render', () => {
    // `translate` falls back to the key itself, so an undefined key is not an
    // exception — it is the raw identifier rendered into the interface.
    const missing = new Set<string>()
    for (const file of sourceFiles(SOURCE_ROOT))
      for (const key of literalKeys(readFileSync(file, 'utf8'))) {
        if (translate(key) === key) missing.add(key)
      }

    expect([...missing].sort()).toEqual([])
  })

  it('passes every placeholder a template asks for', () => {
    // `translate` leaves `{name}` verbatim when the caller omits it, so a
    // partial params object is not an exception — it is literal braces
    // rendered into the interface.
    const broken: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT))
      for (const site of callSites(readFileSync(file, 'utf8'))) {
        const names = [...translate(site.key).matchAll(/\{(\w+)\}/gu)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        )
        const supplied = names.length === 0 ? undefined : suppliedNames(site.args)
        if (supplied === undefined) continue
        const missing = names.filter((name) => !supplied.includes(name))
        if (missing.length > 0)
          broken.push(`${relative(SOURCE_ROOT, file)}: ${site.key} missing ${missing.join(', ')}`)
      }

    expect(broken.sort()).toEqual([])
  })

  it('labels every protocol enum value that a dynamic key can build', () => {
    // Values reached through `t(`changes.status.${status}`)` are invisible to the
    // literal scan above, so derive them from the protocol schemas instead. The
    // kebab-case protocol values become the camelCase the drawers render.
    const camel = (value: string): string =>
      value.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
    const prefixes: readonly (readonly [string, readonly string[]])[] = [
      ['changes.status.', changeSummarySchema.shape.status.options],
      ['changes.evidence.', changeSummarySchema.shape.evidence.options.map(camel)],
      ['changes.application.', changeSummarySchema.shape.applicationState.options.map(camel)],
      ['changes.review.', changeSummarySchema.shape.reviewState.options],
      ['checkpoints.state.', checkpointSummarySchema.shape.state.options],
      ['tasks.kind.', taskSummarySchema.shape.kind.options],
      ['promptTemplates.scope.', promptTemplateSummarySchema.shape.scope.options],
    ]

    const missing: string[] = []
    for (const [prefix, values] of prefixes)
      for (const value of values) {
        if (translate(`${prefix}${value}`) === `${prefix}${value}`) missing.push(`${prefix}${value}`)
      }

    expect(missing).toEqual([])
  })

  it('labels every value the remaining template keys can build', () => {
    // The families above come from the protocol schemas; these come from the
    // domain unions the drawers actually render, so they are checked against
    // the unions rather than against a copied list of strings.
    const families: readonly (readonly [string, readonly string[]])[] = [
      ['goal.status.', Object.keys(GOAL_STATUS)],
      ['todo.status.', Object.keys(TODO_STATUS)],
      ['jobs.status.', Object.keys(JOB_STATUS)],
      ['workflow.status.', Object.keys(WORKFLOW_STATUS)],
      ['sessions.status.', Object.keys(SESSION_STATUS)],
      ['plugins.phase.', Object.keys(PLUGIN_PHASE)],
      ['approval.risk.', Object.keys(APPROVAL_RISK)],
      ['export.format.', Object.keys(EXPORT_FORMAT)],
      ['controls.workflowMode.', PROMPT_MODES],
      ['diagnostics.state.', Object.keys(DIAGNOSTICS_STATE)],
      ['diagnostics.endpoint.', Object.keys(DIAGNOSTICS_ENDPOINT)],
      ['runtime.status.', Object.keys(RUNTIME_STATUS_TEMPLATE)],
      ['message.feedbackCategory.', Object.keys(FEEDBACK_CATEGORY)],
      ['subagents.diagnostic.', Object.keys(SUBAGENT_DIAGNOSTIC_REASON)],
      ['runtime.connectionProgress.stage.', Object.keys(RUNTIME_CONNECTION_STAGE)],
      ['timeline.teamStatus.', Object.keys(TEAM_STATUS_VALUE)],
      ['timeline.teamDelivery.', Object.keys(TEAM_DELIVERY_MODE)],
      ['presets.', Object.keys(PRESET_COPY_BLOCKER)],
      [
        'settings.value.',
        [...Object.keys(SETTINGS_VALUE), ...THEME_PREFERENCE_OPTIONS, ...CONVERSATION_FONT_SIZE_OPTIONS],
      ],
    ]

    const missing: string[] = []
    for (const [prefix, values] of families)
      for (const value of values) {
        const key = `${prefix}${value}`
        if (translate(key) === key) missing.push(key)
      }

    // Branches the templates above cannot express: a null Fiber phase and the
    // four runtime kinds `RuntimeStatus` maps to fixed labels.
    for (const key of [
      'plugins.phase.unmounted',
      'runtime.status.connected',
      'runtime.status.runtime-missing',
      'runtime.status.connection-failed',
    ])
      if (translate(key) === key) missing.push(key)

    // The pin is a type-level assertion; reading it here keeps it load-bearing
    // and documents that summary and member rows share the family.
    expect(WORKFLOW_MEMBER_STATUS_PINNED).toBe(true)
    // Teeth: an absent key must come back as itself, otherwise every check
    // above would hold even if the dictionary lookup stopped working.
    expect(translate('goal.status.archived')).toBe('goal.status.archived')
    expect(missing).toEqual([])
  })

  it('resolves every key a component key table supplies', () => {
    // `t(row.labelKey)` never appears as a literal call site, so the scan above
    // is blind to these keys; the tables are the only place they exist.
    let supplied = 0
    const missing: string[] = []
    for (const file of sourceFiles(SOURCE_ROOT))
      for (const match of readFileSync(file, 'utf8').matchAll(KEY_TABLE_FIELDS)) {
        const key = match[1]
        if (key === undefined) continue
        supplied += 1
        if (translate(key) === key) missing.push(`${relative(SOURCE_ROOT, file)}: ${key}`)
      }

    expect(supplied).toBeGreaterThan(10)
    expect(missing.sort()).toEqual([])
  })
})
