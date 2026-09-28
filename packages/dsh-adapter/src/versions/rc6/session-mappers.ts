import type {
  ModelDescriptor,
  ModelInputModality,
  ModelProvider,
  SessionStatus,
  SessionSummary,
  WorkspaceSummary,
} from '@dsh-vscode/domain'

import {
  array,
  boolean,
  date,
  firstString,
  number,
  object,
  requiredArray,
  string,
  stringOr,
} from './value-guards.js'
import { recordOrUndefined as objectOrUndefined } from '../../repositories/shared/guards.js'

export function sessionSummary(value: unknown): SessionSummary {
  const record = object(value, 'session summary')
  const id = string(record.sessionId ?? record.id, 'sessionId')
  const projections = objectOrUndefined(record.projections)
  const projectionValues = objectOrUndefined(projections?.values)
  const updatedAt = date(record.updatedAt ?? record.createdAt)
  const running = boolean(record.running, false)
  const blank = boolean(record.blank, false)
  const status: SessionStatus = running ? 'running' : 'idle'
  const rawTitle = record.title ?? record.name ?? projectionValues?.title
  const modelRecord = objectOrUndefined(record.model)
  const rawModelLabel =
    record.modelLabel ??
    modelRecord?.label ??
    modelRecord?.name ??
    modelRecord?.modelId ??
    (typeof record.model === 'string' ? record.model : undefined)
  const cwd = firstString(record.cwd, record.workingDirectory)
  return {
    id,
    workspaceId: stringOr(record.workspaceId, ''),
    ...(cwd === undefined ? {} : { cwd }),
    // rc.6 keeps command-only sessions blank. Their projection title may be
    // the command's success text, but that is not conversation content and
    // must not turn a reusable New Session into a history row.
    title: blank ? 'New Session' : normalizeSessionTitle(rawTitle),
    blank,
    ...(record.parentSessionId === undefined
      ? {}
      : { parentSessionId: string(record.parentSessionId, 'parentSessionId') }),
    ...(record.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof record.agentAvailable === 'boolean' ? { agentAvailable: record.agentAvailable } : {}),
    status,
    createdAt: date(record.createdAt ?? record.updatedAt),
    updatedAt,
    ...(rawModelLabel === undefined ? {} : { modelLabel: stringOr(rawModelLabel, '') }),
    ...(typeof record.agentPreset === 'string' ? { agentPreset: record.agentPreset } : {}),
    ...(projectionValues === undefined
      ? {}
      : {
          projection: {
            asOfSequence: number(projections?.asOfSeq, -1),
            values: projectionValues,
          },
        }),
  }
}

export function workspace(value: unknown): WorkspaceSummary {
  const record = object(value, 'workspace')
  const id = string(record.workspaceId ?? record.id, 'workspaceId')
  const updatedAt = date(record.updatedAt ?? record.createdAt)
  const sessionIds = array(record.sessionIds).filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  )
  return {
    id,
    name: stringOr(record.title ?? record.name, id),
    path: string(record.path, 'path'),
    createdAt: date(record.createdAt ?? record.updatedAt),
    updatedAt,
    sessionCount: sessionIds.length || number(record.sessionCount, 0),
    ...(sessionIds.length === 0 ? {} : { sessionIds }),
  }
}

export function provider(value: unknown): ModelProvider {
  const record = object(value, 'provider')
  const id = string(record.provider ?? record.id, 'provider')
  // The pinned provider directory treats settingsPath as an atomic path.
  // Never filter malformed segments: changing the path changes which
  // settings object (and potentially which credential) the caller edits.
  const settingsPath = requiredArray(record.settingsPath, 'provider settingsPath').map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) throw new Error('Malformed provider settingsPath')
    return entry
  })
  const fields = array(record.fields).map((entry) => {
    const field = object(entry, 'provider field')
    const secret = boolean(field.secret, false)
    return {
      key: string(field.key ?? field.name, 'field key'),
      label: stringOr(field.label ?? field.name, 'Setting'),
      secret,
      required: boolean(field.required, false),
      ...(secret || field.value === undefined ? {} : { value: stringOr(field.value, '') }),
    }
  })
  return {
    id,
    name: stringOr(record.displayName ?? record.name, id),
    // Addressless live routes have an intentional empty settingsNs marker;
    // do not let that marker become an empty UI kind.
    kind: firstString(record.kind, record.settingsNs) ?? 'provider',
    // `declared` means that the route was hand-declared by the deployment;
    // it does not mean that a shipped provider is read-only.  Upstream's
    // provider directory exposes every configured route to the Models page,
    // so only an explicit `configurable: false` can disable editing.
    configurable: boolean(record.configurable, true),
    ...(typeof record.active === 'boolean' ? { active: record.active } : {}),
    ...(typeof record.declared === 'boolean' ? { declared: record.declared } : {}),
    ...(typeof record.settingsNs === 'string' ? { settingsNs: record.settingsNs } : {}),
    settingsPath,
    fields,
  }
}

export function model(value: unknown): ModelDescriptor {
  const record = object(value, 'model')
  const reasoning = objectOrUndefined(record.reasoning)
  const context = objectOrUndefined(record.context)
  const efforts =
    reasoning === undefined
      ? []
      : array(reasoning.efforts)
          .map((effort) => {
            const item = object(effort, 'reasoning effort')
            const id = stringOr(item.id, '')
            return { id, label: stringOr(item.name, id) }
          })
          .filter((level) => level.id !== '')
  const defaultEffort = stringOr(reasoning?.defaultEffort, '')
  const inputModalities =
    record.inputModalities === undefined ? undefined : modelInputModalities(record.inputModalities)
  return {
    id: string(record.id, 'model id'),
    providerId: stringOr(record.providerId ?? record.provider, ''),
    label: stringOr(record.name ?? record.label, stringOr(record.id, 'Model')),
    ...(record.contextWindow === undefined && context?.contextWindow === undefined
      ? {}
      : { contextWindow: number(record.contextWindow ?? context?.contextWindow, 0) }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    supportsReasoning: reasoning !== undefined,
    ...(efforts.length === 0 ? {} : { reasoningLevels: efforts }),
    ...(defaultEffort === '' ? {} : { defaultReasoningLevel: defaultEffort }),
  }
}

function modelInputModalities(value: unknown): ModelInputModality[] {
  return array(value).map((modality) => {
    if (modality !== 'text' && modality !== 'image') throw new Error('Malformed model input modalities')
    return modality
  })
}

function normalizeSessionTitle(value: unknown): string {
  const title = stringOr(value, '').trim()
  if (title === '' || /^session\s+session-/i.test(title)) return 'New Session'
  return title
}
