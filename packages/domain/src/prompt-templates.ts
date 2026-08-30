import { AppError } from './errors.js'

export const PROMPT_TEMPLATE_VARIABLES = [
  'selection',
  'currentFile',
  'currentDiagnostics',
  'currentSymbol',
  'workspaceName',
  'sessionTitle',
] as const

export type PromptTemplateVariable = (typeof PROMPT_TEMPLATE_VARIABLES)[number]
export type PromptTemplateScope = 'workspace' | 'global' | 'session'
export const PROMPT_MODES = ['ask', 'plan', 'act', 'debug', 'review'] as const
export type PromptMode = (typeof PROMPT_MODES)[number]

export interface PromptModeCapabilities {
  readonly planCommandAvailable: boolean
}

export interface PromptModeResolution {
  readonly mode: PromptMode
  readonly supported: boolean
  readonly planEnabled: boolean
  readonly reason?: string
}

export interface PromptTemplateSummary {
  readonly templateId: string
  readonly title: string
  readonly description: string
  readonly scope: PromptTemplateScope
  readonly updatedAt: number
  readonly variables: readonly PromptTemplateVariable[]
  readonly enabled: boolean
}

export interface PromptTemplate extends PromptTemplateSummary {
  readonly templateText: string
}

export interface PromptTemplateDraft {
  readonly title: string
  readonly description: string
  readonly templateText: string
  readonly scope: PromptTemplateScope
  readonly variables: readonly string[]
}

export interface PromptTemplateUpdate {
  readonly title?: string
  readonly description?: string
  readonly templateText?: string
  readonly variables?: readonly string[]
}

export interface PromptTemplateOwner {
  readonly workspaceFolderId: string
  readonly sessionId?: string
}

export interface PromptTemplateListQuery extends PromptTemplateOwner {
  readonly scope?: PromptTemplateScope
}

export interface PromptTemplateInsertion {
  readonly templateId: string
  readonly text: string
  readonly unresolvedVariables: readonly PromptTemplateVariable[]
}

export interface PromptTemplateRepository {
  list(query: PromptTemplateListQuery, signal?: AbortSignal): Promise<readonly PromptTemplateSummary[]>
  read(templateId: string, owner: PromptTemplateOwner, signal?: AbortSignal): Promise<PromptTemplate>
  insert(
    templateId: string,
    variables: Readonly<Record<string, string>> | undefined,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateInsertion>
  create(
    draft: PromptTemplateDraft,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary>
  update(
    templateId: string,
    patch: PromptTemplateUpdate,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary>
  delete(templateId: string, owner: PromptTemplateOwner, signal?: AbortSignal): Promise<void>
}

/** Resolve a semantic workflow mode without inventing provider/tool or permission ids. */
export function resolvePromptMode(
  mode: PromptMode,
  capabilities: PromptModeCapabilities,
): PromptModeResolution {
  if (!isPromptMode(mode)) throw invalidTemplate('Prompt mode is invalid.')
  if (mode === 'plan' && !capabilities.planCommandAvailable) {
    return {
      mode,
      supported: false,
      planEnabled: false,
      reason: 'The connected DSH session does not advertise the plan command.',
    }
  }
  return { mode, supported: true, planEnabled: mode === 'plan' }
}

export function normalizePromptTemplateDraft(input: PromptTemplateDraft): PromptTemplateDraft {
  const title = input.title.trim()
  const description = input.description.trim()
  const templateText = input.templateText
  const variables = uniqueStrings(input.variables)
  if (title === '' || title.length > 256 || description.length > 2_000 || templateText.length === 0)
    throw invalidTemplate('Template metadata is invalid.')
  if (byteLength(templateText) > 100_000) throw invalidTemplate('Template text is too large.')
  if (!isPromptTemplateScope(input.scope)) throw invalidTemplate('Template scope is invalid.')
  if (variables.length > 64) throw invalidTemplate('A template may declare at most 64 variables.')
  for (const variable of variables)
    if (!isPromptTemplateVariable(variable))
      throw invalidTemplate(`Unsupported template variable: ${variable}.`)
  for (const variable of referencedVariables(templateText))
    if (!isPromptTemplateVariable(variable) || !variables.includes(variable))
      throw invalidTemplate(`Template variable ${variable} must be explicitly declared.`)
  return { title, description, templateText, scope: input.scope, variables }
}

export function expandPromptTemplate(
  template: Pick<PromptTemplate, 'templateId' | 'templateText'> & {
    readonly variables: readonly PromptTemplateVariable[]
  },
  values: Readonly<Record<string, string>> | undefined,
): PromptTemplateInsertion {
  const provided = values ?? {}
  for (const [key, value] of Object.entries(provided)) {
    if (!isPromptTemplateVariable(key) || byteLength(value) > 10_000)
      throw invalidTemplate('Template variable values are invalid.')
  }
  const unresolved = new Set<PromptTemplateVariable>()
  const text = template.templateText.replace(
    /\{\{([A-Za-z][A-Za-z0-9_-]{0,127})\}\}/gu,
    (token, name: string) => {
      if (!isPromptTemplateVariable(name) || !template.variables.includes(name)) return token
      const value = provided[name]
      if (value === undefined) {
        unresolved.add(name)
        return token
      }
      return value
    },
  )
  if (byteLength(text) > 100_000)
    throw new AppError({
      code: 'CONTEXT_LIMIT',
      message: 'Expanded template text is too large.',
      retryable: false,
    })
  return {
    templateId: template.templateId,
    text,
    unresolvedVariables: [...unresolved],
  }
}

export function promptTemplateSummary(template: PromptTemplate): PromptTemplateSummary {
  return {
    templateId: template.templateId,
    title: template.title,
    description: template.description,
    scope: template.scope,
    updatedAt: template.updatedAt,
    variables: [...template.variables],
    enabled: template.enabled,
  }
}

export function isPromptTemplateVariable(value: string): value is PromptTemplateVariable {
  return (PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(value)
}

export function isPromptMode(value: string): value is PromptMode {
  return (PROMPT_MODES as readonly string[]).includes(value)
}

function referencedVariables(value: string): readonly string[] {
  return [
    ...new Set(
      [...value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_-]{0,127})\}\}/gu)].map((match) => match[1] ?? ''),
    ),
  ]
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ''))]
}

function isPromptTemplateScope(value: string): value is PromptTemplateScope {
  return value === 'workspace' || value === 'global' || value === 'session'
}

function invalidTemplate(message: string): AppError {
  return new AppError({ code: 'INVALID_CONFIGURATION', message, retryable: false })
}

function byteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00)
        index += 1
      }
    }
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}
