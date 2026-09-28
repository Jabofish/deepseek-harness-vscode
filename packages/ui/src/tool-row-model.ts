import { terminalPresentationFailed, type ToolCallView } from '@dsh-vscode/domain'

import {
  decodeToolValue,
  formatToolText,
  toolNameLabel,
  toolPresentation,
  type PresentationTranslate,
  type ToolDetailBlock,
} from './tool-presentation.js'
import { arrayCount, firstLine, label, stringField } from './tool-row-text.js'
import { removeDuplicateErrorSections, skillSections, structuredSections } from './tool-row-sections.js'

export type ToolRowVariant =
  'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'todo' | 'question' | 'web' | 'skill' | 'other'

export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

export interface ToolRowModel {
  readonly variant: ToolRowVariant
  readonly state: ToolRowState
  readonly title: string
  readonly summary: string
  readonly sections: readonly ToolDetailBlock[]
  readonly errorSummary?: string
  readonly autoReviewOutput?: string
}

/**
 * Official DSH tool names are dispatch keys, not a capability inventory. This
 * classifier only selects a presentation family; an unrecognized tool always
 * remains on the generic ToolCard path.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  switch (toolName.trim().toLocaleLowerCase()) {
    case 'web_search':
    case 'grep':
    case 'glob':
      return 'search'
    case 'read':
    case 'cordis_package_inspect':
    case 'cordis_runtime_inspect':
      return 'read'
    case 'bash':
    case 'pwsh':
      return 'bash'
    case 'write':
      return 'write'
    case 'edit':
      return 'edit'
    case 'run_code':
      return 'code'
    case 'todo_write':
      return 'todo'
    case 'ask_user_question':
      return 'question'
    case 'web_fetch':
      return 'web'
    case 'skill':
      return 'skill'
    default:
      return 'other'
  }
}

export function isSpecializedTool(tool: ToolCallView): boolean {
  const name = tool.name.trim().toLocaleLowerCase()
  return (
    classifyTool(name) !== 'other' ||
    name === 'cordis_run' ||
    name === 'cordis_stop' ||
    name === 'cordis_undefine'
  )
}

export function toolRowModel(tool: ToolCallView, translate?: PresentationTranslate): ToolRowModel {
  const variant = classifyTool(tool.name)
  const title = rowTitle(variant, tool, translate)
  if (tool.autoReviewDenial !== undefined) {
    const summary = label(translate, 'toolrow.autoReview.rejected', 'Rejected by Auto review')
    return {
      variant,
      state: 'error',
      title,
      summary,
      sections: [],
      errorSummary: summary,
      autoReviewOutput: autoReviewDenialOutput(tool.autoReviewDenial.reason, translate),
    }
  }
  const presentation = toolPresentation(tool, translate)
  const state = rowState(tool)
  const summary = rowSummary(variant, tool, translate)
  const structured = structuredSections(tool.presentation, translate)
  const sections =
    structured !== undefined
      ? structured
      : variant === 'skill'
        ? skillSections(tool, translate)
        : [...presentation.request, ...presentation.response]
  const visibleSections = removeDuplicateErrorSections(sections, tool.error, translate)
  // A failing exit is stated by the card's own status pill; the row must not
  // echo the bare exit number as if it were the failure text.
  const errorText =
    tool.error ??
    (state === 'error' && !terminalPresentationFailed(tool.presentation)
      ? sections[sections.length - 1]?.content
      : undefined)
  return {
    variant,
    state,
    title,
    summary,
    sections: visibleSections,
    ...(state === 'error' && errorText !== undefined ? { errorSummary: firstLine(errorText) } : {}),
  }
}

export function rowState(tool: ToolCallView): ToolRowState {
  if (tool.autoReviewDenial !== undefined) return 'error'
  if (tool.status === 'queued' || tool.status === 'running') return 'running'
  if (tool.status === 'cancelled') return 'stopped'
  if (tool.status === 'failed' || tool.error !== undefined) return 'error'
  return terminalPresentationFailed(tool.presentation) ? 'error' : 'ok'
}

export function autoReviewDenialOutput(reason: string | undefined, t?: PresentationTranslate): string {
  const normalized = reason
    ?.trim()
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .trim()
  const visibleReason =
    normalized === undefined || normalized === ''
      ? label(t, 'toolrow.autoReview.reasonFallback', 'Auto review did not authorize this action')
      : normalized
  return t === undefined
    ? `Tool was not executed. Manual approval is required to continue. Reason: ${visibleReason}`
    : t('toolrow.autoReview.notExecuted', { reason: visibleReason })
}

export function rowTitle(variant: ToolRowVariant, tool: ToolCallView, t?: PresentationTranslate): string {
  const name = tool.name.trim().toLocaleLowerCase()
  if (name === 'ask_user_question' || name === 'question')
    return toolNameLabel(tool.name, t) ?? label(t, 'toolrow.title.question', 'Question')
  if (name === 'pwsh') return label(t, 'toolrow.title.pwsh', 'Pwsh')
  if (name === 'web_search') return label(t, 'toolrow.title.search', 'Search')
  if (name === 'web_fetch') return label(t, 'toolrow.title.fetch', 'Fetch')
  if (name === 'cordis_package_inspect' || name === 'cordis_runtime_inspect')
    return label(t, 'toolrow.title.inspect', 'Inspect')
  if (name === 'cordis_run') return label(t, 'toolrow.title.cordisRun', 'Run Cordis Plugin')
  if (name === 'cordis_stop') return label(t, 'toolrow.title.cordisStop', 'Stop Cordis Plugin')
  if (name === 'cordis_undefine') return label(t, 'toolrow.title.cordisUndefine', 'Remove Cordis Plugin')
  const key = `toolrow.title.${variant}`
  const fallback: Record<ToolRowVariant, string> = {
    search: 'Search',
    read: 'Read',
    bash: 'Bash',
    write: 'Write',
    edit: 'Edit',
    code: 'Code',
    todo: 'To-do',
    question: 'Question',
    web: 'Web',
    skill: 'Skill',
    other: tool.title.trim() || 'Tool call',
  }
  return label(t, key, fallback[variant])
}

export function rowSummary(variant: ToolRowVariant, tool: ToolCallView, t?: PresentationTranslate): string {
  const parsed = decodeToolValue(tool.inputSummary)
  if (variant === 'skill') {
    return firstLine(stringField(parsed, 'name') ?? formatToolText(tool.inputSummary, t) ?? tool.id)
  }
  if (variant === 'question') {
    if (tool.status === 'queued' || tool.status === 'running')
      return label(t, 'toolrow.question.waiting', 'Waiting for input')
    const answerSummary = summarizeAnswers(tool.outputSummary, t)
    if (answerSummary !== undefined) return answerSummary
    const questionCount = arrayCount(parsed, 'questions')
    if (questionCount !== undefined)
      return label(t, 'toolrow.question.count', `${questionCount} questions`, { count: questionCount })
  }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    if (variant === 'search' && Array.isArray(record.queries)) {
      const queries = record.queries.filter(
        (value): value is string => typeof value === 'string' && value.trim() !== '',
      )
      if (queries.length > 0) return queries.map(firstLine).join(', ')
    }
    if (variant === 'todo') {
      const todoSummary = summarizeTodos(record.todos, t)
      if (todoSummary !== undefined) return todoSummary
    }
    const keys: Partial<Record<ToolRowVariant, readonly string[]>> = {
      bash: ['description', 'command'],
      read: ['path', 'file_path', 'url'],
      search: ['query', 'pattern', 'url'],
      write: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      code: ['description'],
      todo: ['todos', 'items'],
      question: ['prompt', 'question'],
      web: ['url', 'query'],
    }
    for (const key of keys[variant] ?? []) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
      if (Array.isArray(value) && value.length > 0) return `${value.length} items`
    }
    for (const value of Object.values(record)) {
      if (typeof value === 'string' && value.trim() !== '') return firstLine(value)
    }
  }
  return firstLine(formatToolText(tool.inputSummary, t) ?? tool.id)
}

function summarizeTodos(value: unknown, t?: PresentationTranslate): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const items = value.filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
  )
  if (items.length !== value.length) return undefined
  const completed = items.filter(
    (item) => item.status === 'completed' || item.status === 'done' || item.completed === true,
  ).length
  const active = items.find(
    (item) => item.status !== 'completed' && item.status !== 'done' && item.completed !== true,
  )
  const activeText =
    active === undefined
      ? undefined
      : (stringField(active, 'content') ?? stringField(active, 'title') ?? stringField(active, 'subject'))
  const progress = label(t, 'toolrow.todo.progress', `${completed}/${items.length} completed`, {
    completed,
    total: items.length,
  })
  return activeText === undefined ? progress : `${progress} · ${firstLine(activeText)}`
}

function summarizeAnswers(value: string | undefined, t?: PresentationTranslate): string | undefined {
  const parsed = decodeToolValue(value)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const answers = (parsed as Record<string, unknown>).answers
  if (!Array.isArray(answers)) return undefined
  const answered = answers.filter((answer) => {
    if (answer === null || typeof answer !== 'object') return false
    const record = answer as Record<string, unknown>
    return (
      (Array.isArray(record.selected) && record.selected.length > 0) ||
      (typeof record.custom === 'string' && record.custom.trim() !== '')
    )
  }).length
  return label(t, 'toolrow.question.answered', `${answered}/${answers.length} answered`, {
    answered,
    total: answers.length,
  })
}
