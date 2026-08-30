import { createHash, randomUUID } from 'node:crypto'

import {
  AppError,
  expandPromptTemplate,
  isPromptTemplateVariable,
  normalizePromptTemplateDraft,
  promptTemplateSummary,
  type PromptTemplate,
  type PromptTemplateDraft,
  type PromptTemplateInsertion,
  type PromptTemplateListQuery,
  type PromptTemplateOwner,
  type PromptTemplateRepository,
  type PromptTemplateScope,
  type PromptTemplateSummary,
  type PromptTemplateUpdate,
} from '@dsh-vscode/domain'

export interface PromptTemplateScopeStorage {
  mkdir(): Promise<void>
  read(name: string): Promise<Uint8Array | undefined>
  write(name: string, data: Uint8Array): Promise<void>
  rename(sourceName: string, destinationName: string, overwrite: boolean): Promise<void>
  delete(name: string): Promise<void>
}

export interface PromptTemplateStoreOptions {
  readonly global: PromptTemplateScopeStorage
  readonly workspace: (workspaceFolderId: string) => PromptTemplateScopeStorage | undefined
  readonly enabled?: () => boolean
  readonly workspaceTrusted?: () => boolean
  readonly now?: () => number
  readonly makeId?: () => string
}

interface StoredTemplateRecord {
  readonly templateId: string
  readonly title: string
  readonly description: string
  readonly scope: PromptTemplateScope
  readonly workspaceFolderId?: string
  readonly sessionId?: string
  readonly updatedAt: number
  readonly variables: readonly string[]
  readonly enabled: boolean
  readonly bodyRef: string
  readonly bodyHash: string
}

interface StoredTemplateIndex {
  readonly version: 1
  readonly templates: readonly StoredTemplateRecord[]
  readonly checksum: string
}

const INDEX_NAME = 'index.json'
const BODY_NAME = /^template-[a-f0-9]{64}\.md$/u

/** Host-only local template repository. Prompt bodies never enter logs or DSH settings. */
export class PromptTemplateStore implements PromptTemplateRepository {
  private readonly now: () => number
  private readonly makeId: () => string
  private readonly workspaceTrusted: () => boolean
  private readonly enabled: () => boolean
  private readonly records = new Map<string, StoredTemplateRecord>()
  private readonly scopeRecords = new Map<string, Map<string, StoredTemplateRecord>>()
  private readonly scopeStorage = new Map<string, PromptTemplateScopeStorage>()
  private readonly loadedScopes = new Set<string>()
  private initialized = false
  private initializing: Promise<void> | undefined

  public constructor(private readonly options: PromptTemplateStoreOptions) {
    this.now = options.now ?? (() => Date.now())
    this.makeId = options.makeId ?? (() => randomUUID())
    this.enabled = options.enabled ?? (() => true)
    this.workspaceTrusted = options.workspaceTrusted ?? (() => false)
  }

  public async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return
    if (this.initializing !== undefined) return this.initializing
    this.initializing = this.ensureScopeLoaded('global', undefined, signal)
      .then(() => undefined)
      .finally(() => {
        this.initializing = undefined
      })
    await this.initializing
    this.initialized = true
  }

  public async list(
    query: PromptTemplateListQuery,
    signal?: AbortSignal,
  ): Promise<readonly PromptTemplateSummary[]> {
    this.assertEnabled()
    await this.initialize(signal)
    validateOwner(query)
    throwIfAborted(signal)
    if (query.scope === 'workspace') {
      this.assertWorkspaceTrusted()
      await this.ensureScopeLoaded('workspace', query.workspaceFolderId, signal)
    } else if (query.scope === undefined && this.workspaceTrusted()) {
      await this.ensureScopeLoaded('workspace', query.workspaceFolderId, signal)
    }
    const values = [...this.records.values()]
      .filter((record) => this.isVisible(record, query))
      .sort(
        (left, right) => right.updatedAt - left.updatedAt || left.templateId.localeCompare(right.templateId),
      )
    return values.map(recordSummary)
  }

  public async read(
    templateId: string,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplate> {
    const record = await this.requireRecord(templateId, owner, signal)
    return this.readTemplate(record, signal)
  }

  public async insert(
    templateId: string,
    variables: Readonly<Record<string, string>> | undefined,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateInsertion> {
    const template = await this.read(templateId, owner, signal)
    throwIfAborted(signal)
    if (!template.enabled)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The requested prompt template is disabled.',
        retryable: false,
      })
    return expandPromptTemplate(template, variables)
  }

  public async create(
    draft: PromptTemplateDraft,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary> {
    this.assertEnabled()
    await this.initialize(signal)
    validateOwner(owner)
    const normalized = normalizePromptTemplateDraft(draft)
    const storageScope = this.storageScope(normalized.scope, owner)
    const storage = await this.ensureScopeLoaded(storageScope, owner.workspaceFolderId, signal)
    throwIfAborted(signal)
    const templateId = `dsh-template-${this.makeId()}`
    if (this.records.has(templateId)) throw storageCorrupt('Duplicate template id.')
    const record: StoredTemplateRecord = {
      templateId,
      title: normalized.title,
      description: normalized.description,
      scope: normalized.scope,
      ...(normalized.scope === 'workspace' || normalized.scope === 'session'
        ? { workspaceFolderId: owner.workspaceFolderId }
        : {}),
      ...(normalized.scope === 'session'
        ? owner.sessionId === undefined
          ? (() => {
              throw new AppError({
                code: 'RESOURCE_NOT_OWNED',
                message: 'A session template requires an active session.',
                retryable: false,
              })
            })()
          : { sessionId: owner.sessionId }
        : {}),
      updatedAt: this.now(),
      variables: normalized.variables,
      enabled: true,
      bodyHash: sha256(Buffer.from(normalized.templateText, 'utf8')),
      bodyRef: bodyRefFor(templateId, sha256(Buffer.from(normalized.templateText, 'utf8'))),
    }
    const scopeKey = this.scopeKey(storageScope, owner.workspaceFolderId)
    const scopeMap = this.scopeRecords.get(scopeKey)
    if (scopeMap === undefined) throw storageCorrupt('Template scope is not loaded.')
    scopeMap.set(record.templateId, record)
    try {
      await this.writeAtomic(storage, record.bodyRef, Buffer.from(normalized.templateText, 'utf8'), signal)
      await this.persistScope(scopeKey, storage, signal)
      this.registerRecord(record, storage, scopeKey)
      return recordSummary(record)
    } catch (error) {
      scopeMap.delete(record.templateId)
      await this.persistScope(scopeKey, storage).catch(() => undefined)
      await storage.delete(record.bodyRef).catch(() => undefined)
      throw normalizeStorageError(error)
    }
  }

  public async update(
    templateId: string,
    patch: PromptTemplateUpdate,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<PromptTemplateSummary> {
    const record = await this.requireRecord(templateId, owner, signal)
    if (record.scope === 'workspace') this.assertWorkspaceTrusted()
    const current = await this.readTemplate(record, signal)
    const normalized = normalizePromptTemplateDraft({
      title: patch.title ?? current.title,
      description: patch.description ?? current.description,
      templateText: patch.templateText ?? current.templateText,
      scope: current.scope,
      variables: patch.variables ?? current.variables,
    })
    const next: StoredTemplateRecord = {
      ...record,
      title: normalized.title,
      description: normalized.description,
      updatedAt: this.now(),
      variables: normalized.variables,
      bodyHash: sha256(Buffer.from(normalized.templateText, 'utf8')),
      bodyRef: bodyRefFor(templateId, sha256(Buffer.from(normalized.templateText, 'utf8'))),
    }
    const storage = this.scopeStorage.get(this.recordScopeKey(record))
    const scopeMap = this.scopeRecords.get(this.recordScopeKey(record))
    if (storage === undefined || scopeMap === undefined) throw storageCorrupt('Template scope is not loaded.')
    const oldBody = Buffer.from(current.templateText, 'utf8')
    scopeMap.set(templateId, next)
    try {
      await this.writeAtomic(storage, next.bodyRef, Buffer.from(normalized.templateText, 'utf8'), signal)
      await this.persistScope(this.recordScopeKey(record), storage, signal)
      this.records.set(templateId, next)
      if (next.bodyRef !== record.bodyRef) await storage.delete(record.bodyRef).catch(() => undefined)
      return recordSummary(next)
    } catch (error) {
      scopeMap.set(templateId, record)
      this.records.set(templateId, record)
      await this.persistScope(this.recordScopeKey(record), storage).catch(() => undefined)
      if (next.bodyRef !== record.bodyRef) await storage.delete(next.bodyRef).catch(() => undefined)
      else await this.writeAtomic(storage, record.bodyRef, oldBody).catch(() => undefined)
      throw normalizeStorageError(error)
    }
  }

  public async delete(templateId: string, owner: PromptTemplateOwner, signal?: AbortSignal): Promise<void> {
    const record = await this.requireRecord(templateId, owner, signal)
    if (record.scope === 'workspace') this.assertWorkspaceTrusted()
    const scopeKey = this.recordScopeKey(record)
    const storage = this.scopeStorage.get(scopeKey)
    const scopeMap = this.scopeRecords.get(scopeKey)
    if (storage === undefined || scopeMap === undefined) throw storageCorrupt('Template scope is not loaded.')
    throwIfAborted(signal)
    scopeMap.delete(templateId)
    try {
      await this.persistScope(scopeKey, storage, signal)
      this.records.delete(templateId)
      await storage.delete(record.bodyRef).catch(() => undefined)
    } catch (error) {
      scopeMap.set(templateId, record)
      await this.persistScope(scopeKey, storage).catch(() => undefined)
      throw normalizeStorageError(error)
    }
  }

  private async requireRecord(
    templateId: string,
    owner: PromptTemplateOwner,
    signal?: AbortSignal,
  ): Promise<StoredTemplateRecord> {
    this.assertEnabled()
    await this.initialize(signal)
    validateOwner(owner)
    throwIfAborted(signal)
    let record = this.records.get(templateId)
    if (record === undefined && this.workspaceTrusted()) {
      await this.ensureScopeLoaded('workspace', owner.workspaceFolderId, signal)
      record = this.records.get(templateId)
    }
    if (record === undefined)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The requested prompt template is no longer available.',
        retryable: false,
      })
    this.assertOwnership(record, owner)
    if (!record.enabled)
      throw new AppError({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'The requested prompt template is disabled.',
        retryable: false,
      })
    return record
  }

  private async readTemplate(record: StoredTemplateRecord, signal?: AbortSignal): Promise<PromptTemplate> {
    throwIfAborted(signal)
    const storage = this.scopeStorage.get(this.recordScopeKey(record))
    if (storage === undefined) throw storageCorrupt('Template scope is not loaded.')
    const bytes = await storage.read(record.bodyRef)
    throwIfAborted(signal)
    if (bytes === undefined || sha256(bytes) !== record.bodyHash) {
      await this.disableRecord(record).catch(() => undefined)
      throw storageCorrupt('Template body failed its integrity check.')
    }
    const templateText = Buffer.from(bytes).toString('utf8')
    let normalized: PromptTemplateDraft
    try {
      normalized = normalizePromptTemplateDraft({
        title: record.title,
        description: record.description,
        templateText,
        scope: record.scope,
        variables: record.variables,
      })
    } catch {
      await this.disableRecord(record).catch(() => undefined)
      throw storageCorrupt('Template body metadata is invalid.')
    }
    const variables = normalized.variables.filter(isPromptTemplateVariable)
    return {
      templateId: record.templateId,
      ...normalized,
      updatedAt: record.updatedAt,
      variables,
      enabled: record.enabled,
    }
  }

  private async disableRecord(record: StoredTemplateRecord): Promise<void> {
    const scopeKey = this.recordScopeKey(record)
    const storage = this.scopeStorage.get(scopeKey)
    const scopeMap = this.scopeRecords.get(scopeKey)
    if (storage === undefined || scopeMap === undefined) return
    const disabled = { ...record, enabled: false }
    scopeMap.set(record.templateId, disabled)
    await this.persistScope(scopeKey, storage)
    this.records.set(record.templateId, disabled)
  }

  private async ensureScopeLoaded(
    scope: 'global' | 'workspace',
    workspaceFolderId: string | undefined,
    signal?: AbortSignal,
  ): Promise<PromptTemplateScopeStorage> {
    throwIfAborted(signal)
    const scopeKey = this.scopeKey(scope, workspaceFolderId)
    const existing = this.scopeStorage.get(scopeKey)
    if (existing !== undefined && this.loadedScopes.has(scopeKey)) return existing
    const storage =
      scope === 'global'
        ? this.options.global
        : workspaceFolderId === undefined
          ? undefined
          : this.options.workspace(workspaceFolderId)
    if (storage === undefined) throw resourceNotOwned()
    await storage.mkdir()
    throwIfAborted(signal)
    const raw = await storage.read(INDEX_NAME)
    const index = raw === undefined ? emptyIndex() : decodeIndex(raw)
    const scopeMap = new Map<string, StoredTemplateRecord>()
    for (const record of index.templates) {
      if (!isStoredTemplateRecord(record)) throw storageCorrupt('Template index contains invalid metadata.')
      if (
        scope === 'workspace' &&
        (record.scope !== 'workspace' || record.workspaceFolderId !== workspaceFolderId)
      )
        throw storageCorrupt('Workspace template index contains an invalid owner.')
      if (scope === 'global' && record.scope === 'workspace')
        throw storageCorrupt('Global template index contains a workspace template.')
      if (scopeMap.has(record.templateId) || this.records.has(record.templateId))
        throw storageCorrupt('Template index contains a duplicate id.')
      scopeMap.set(record.templateId, record)
    }
    this.scopeStorage.set(scopeKey, storage)
    this.scopeRecords.set(scopeKey, scopeMap)
    this.loadedScopes.add(scopeKey)
    for (const record of scopeMap.values()) this.records.set(record.templateId, record)
    throwIfAborted(signal)
    return storage
  }

  private async persistScope(
    scopeKey: string,
    storage: PromptTemplateScopeStorage,
    signal?: AbortSignal,
  ): Promise<void> {
    const scopeMap = this.scopeRecords.get(scopeKey)
    if (scopeMap === undefined) throw storageCorrupt('Template scope is not loaded.')
    const templates = [...scopeMap.values()].sort((left, right) =>
      left.templateId.localeCompare(right.templateId),
    )
    const payload = { version: 1 as const, templates }
    const checksum = sha256(Buffer.from(JSON.stringify(payload), 'utf8'))
    const index: StoredTemplateIndex = { ...payload, checksum }
    await this.writeAtomic(storage, INDEX_NAME, Buffer.from(JSON.stringify(index), 'utf8'), signal)
  }

  private async writeAtomic(
    storage: PromptTemplateScopeStorage,
    name: string,
    data: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    const temporary = `${name}.tmp-${sha256(this.makeId()).slice(0, 16)}`
    try {
      await storage.write(temporary, data)
      throwIfAborted(signal)
      await storage.rename(temporary, name, true)
    } catch (error) {
      await storage.delete(temporary).catch(() => undefined)
      throw error
    }
  }

  private storageScope(scope: PromptTemplateScope, owner: PromptTemplateOwner): 'global' | 'workspace' {
    if (scope === 'workspace') {
      this.assertWorkspaceTrusted()
      if (this.options.workspace(owner.workspaceFolderId) === undefined) throw resourceNotOwned()
    }
    if (scope === 'session' && owner.sessionId === undefined) {
      throw new AppError({
        code: 'RESOURCE_NOT_OWNED',
        message: 'A session template requires an active session.',
        retryable: false,
      })
    }
    return scope === 'workspace' ? 'workspace' : 'global'
  }

  private scopeKey(scope: 'global' | 'workspace', workspaceFolderId: string | undefined): string {
    return scope === 'global' ? 'global' : `workspace:${workspaceFolderId ?? ''}`
  }

  private recordScopeKey(record: StoredTemplateRecord): string {
    return this.scopeKey(record.scope === 'workspace' ? 'workspace' : 'global', record.workspaceFolderId)
  }

  private isVisible(record: StoredTemplateRecord, query: PromptTemplateListQuery): boolean {
    if (query.scope !== undefined && record.scope !== query.scope) return false
    if (record.scope === 'workspace' && record.workspaceFolderId !== query.workspaceFolderId) return false
    if (record.scope === 'session')
      return record.workspaceFolderId === query.workspaceFolderId && record.sessionId === query.sessionId
    return true
  }

  private assertOwnership(record: StoredTemplateRecord, owner: PromptTemplateOwner): void {
    if (record.scope === 'global') return
    if (record.scope === 'workspace') {
      this.assertWorkspaceTrusted()
      if (record.workspaceFolderId === owner.workspaceFolderId) return
    } else if (
      record.workspaceFolderId === owner.workspaceFolderId &&
      record.sessionId !== undefined &&
      record.sessionId === owner.sessionId
    ) {
      return
    }
    throw new AppError({
      code: 'RESOURCE_NOT_OWNED',
      message: 'The requested prompt template is not owned by this workspace or session.',
      retryable: false,
    })
  }

  private registerRecord(
    record: StoredTemplateRecord,
    storage: PromptTemplateScopeStorage,
    scopeKey: string,
  ): void {
    this.records.set(record.templateId, record)
    this.scopeStorage.set(scopeKey, storage)
  }

  private assertWorkspaceTrusted(): void {
    if (this.workspaceTrusted()) return
    throw new AppError({
      code: 'PERMISSION_DENIED',
      message: 'Workspace prompt templates require a trusted workspace.',
      retryable: false,
    })
  }

  private assertEnabled(): void {
    if (this.enabled()) return
    throw new AppError({
      code: 'FEATURE_DISABLED',
      message: 'Prompt templates are disabled in extension settings.',
      retryable: false,
    })
  }
}

function recordSummary(record: StoredTemplateRecord): PromptTemplateSummary {
  return promptTemplateSummary({
    templateId: record.templateId,
    title: record.title,
    description: record.description,
    scope: record.scope,
    updatedAt: record.updatedAt,
    variables: record.variables.filter(isPromptTemplateVariable),
    enabled: record.enabled,
    templateText: '',
  })
}

function validateOwner(owner: PromptTemplateOwner): void {
  if (owner.workspaceFolderId.trim() === '') throw resourceNotOwned()
}

function emptyIndex(): StoredTemplateIndex {
  const payload = { version: 1 as const, templates: [] as readonly StoredTemplateRecord[] }
  return { ...payload, checksum: sha256(Buffer.from(JSON.stringify(payload), 'utf8')) }
}

function decodeIndex(bytes: Uint8Array): StoredTemplateIndex {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw storageCorrupt('Template index is not valid JSON.')
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.templates) ||
    typeof value.checksum !== 'string'
  )
    throw storageCorrupt('Template index envelope is invalid.')
  const payload = { version: 1 as const, templates: value.templates }
  if (sha256(Buffer.from(JSON.stringify(payload), 'utf8')) !== value.checksum)
    throw storageCorrupt('Template index checksum is invalid.')
  return { version: 1, templates: value.templates as StoredTemplateRecord[], checksum: value.checksum }
}

function isStoredTemplateRecord(value: unknown): value is StoredTemplateRecord {
  if (!isRecord(value)) return false
  const variables = value.variables
  const validOwner =
    value.scope === 'global'
      ? value.workspaceFolderId === undefined && value.sessionId === undefined
      : value.scope === 'workspace'
        ? typeof value.workspaceFolderId === 'string' &&
          value.workspaceFolderId.trim() !== '' &&
          value.sessionId === undefined
        : typeof value.workspaceFolderId === 'string' &&
          value.workspaceFolderId.trim() !== '' &&
          typeof value.sessionId === 'string' &&
          value.sessionId.trim() !== ''
  return (
    typeof value.templateId === 'string' &&
    value.templateId.length > 0 &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    value.title.length <= 256 &&
    typeof value.description === 'string' &&
    value.description.length <= 2_000 &&
    (value.scope === 'workspace' || value.scope === 'global' || value.scope === 'session') &&
    (value.workspaceFolderId === undefined || typeof value.workspaceFolderId === 'string') &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    typeof value.updatedAt === 'number' &&
    Number.isSafeInteger(value.updatedAt) &&
    Array.isArray(variables) &&
    variables.every((variable) => typeof variable === 'string' && isPromptTemplateVariable(variable)) &&
    new Set(variables).size === variables.length &&
    variables.length <= 64 &&
    validOwner &&
    typeof value.enabled === 'boolean' &&
    typeof value.bodyRef === 'string' &&
    BODY_NAME.test(value.bodyRef) &&
    typeof value.bodyHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.bodyHash)
  )
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function bodyRefFor(templateId: string, bodyHash: string): string {
  return `template-${sha256(`${templateId}:${bodyHash}`)}.md`
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new AppError({
      code: 'REQUEST_CANCELLED',
      message: 'The template operation was cancelled.',
      retryable: true,
    })
}

function resourceNotOwned(): AppError {
  return new AppError({
    code: 'RESOURCE_NOT_OWNED',
    message: 'The requested prompt template workspace is not available.',
    retryable: false,
  })
}

function storageCorrupt(message: string): AppError {
  return new AppError({ code: 'STORAGE_CORRUPT', message, retryable: false })
}

function normalizeStorageError(error: unknown): unknown {
  return error instanceof AppError
    ? error
    : new AppError({
        code: 'STORAGE_CORRUPT',
        message: 'Prompt template storage could not complete the requested operation.',
        retryable: true,
        cause: error,
      })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
