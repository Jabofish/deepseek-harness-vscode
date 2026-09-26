import {
  isPromptMode,
  type QuestionAnswer,
  type SessionSummary,
  type WorkspaceSummary,
} from '@dsh-vscode/domain'
import { parseSessionProjection } from './event-values.js'
import { optionalSequence } from './history-replay.js'
import type { PersistedWebviewState } from './initial-state.js'
import { isAgentConfiguration, normalizedModelSelection } from './model-catalog.js'
import { object } from './unknown-record.js'

export function isSessionStatus(value: unknown): value is SessionSummary['status'] {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'awaiting-input' ||
    value === 'failed' ||
    value === 'completed'
  )
}

export function isQuestionAnswerList(
  value: readonly string[] | readonly QuestionAnswer[],
): value is readonly QuestionAnswer[] {
  return value.some((entry) => typeof entry !== 'string')
}

/** Shapes a question answer payload for the host schema: single selection,
 * label array, or the upstream batch `answers` objects with `custom` text. */
export function questionResponsePayload(
  response: string | readonly string[] | readonly QuestionAnswer[],
):
  | string
  | string[]
  | { readonly id: string; readonly response: string | string[]; readonly custom?: string }[] {
  if (typeof response === 'string') return response
  if (isQuestionAnswerList(response))
    return response.map((entry) => ({
      id: entry.id,
      response: typeof entry.response === 'string' ? entry.response : [...entry.response],
      ...(entry.custom === undefined ? {} : { custom: entry.custom }),
    }))
  return [...response]
}

export function isSessionSummary(value: unknown): value is SessionSummary {
  const item = object(value)
  let projectionValid = true
  if (item?.projection !== undefined) {
    try {
      projectionValid = parseSessionProjection(item.projection) !== undefined
    } catch {
      projectionValid = false
    }
  }
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.workspaceId === 'string' &&
    typeof item.title === 'string' &&
    typeof item.blank === 'boolean' &&
    isSessionStatus(item.status) &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    (item.cwd === undefined || typeof item.cwd === 'string') &&
    (item.workspaceFolderId === undefined ||
      (typeof item.workspaceFolderId === 'string' && item.workspaceFolderId.trim() !== '')) &&
    (item.parentSessionId === undefined ||
      (typeof item.parentSessionId === 'string' && item.parentSessionId.trim() !== '')) &&
    (item.origin === undefined || item.origin === 'subagent') &&
    (item.agentAvailable === undefined || typeof item.agentAvailable === 'boolean') &&
    (item.modelLabel === undefined || typeof item.modelLabel === 'string') &&
    (item.agentPreset === undefined || typeof item.agentPreset === 'string') &&
    projectionValid
  )
}

/**
 * The Extension Host owns the session-open response, but the Webview still
 * treats it as an untrusted protocol boundary. Optional fields are allowed to
 * remain absent for older hosts; once present, critical fields must not be
 * silently converted into empty/default state.
 */
export function isSessionOpenDetail(value: unknown, sessionId: string): value is Record<string, unknown> {
  const detail = object(value)
  if (detail === undefined || detail.id !== sessionId) return false
  try {
    if (!isSessionSummary(detail)) return false
  } catch {
    return false
  }
  const permissionPresets = detail.permissionPresets
  return (
    (detail.configuration === undefined || isAgentConfiguration(detail.configuration)) &&
    (detail.history === undefined || Array.isArray(detail.history)) &&
    (detail.historyHasMore === undefined || typeof detail.historyHasMore === 'boolean') &&
    (detail.historyBeforeSequence === undefined ||
      optionalSequence(detail.historyBeforeSequence) !== undefined) &&
    (permissionPresets === undefined ||
      (Array.isArray(permissionPresets) &&
        permissionPresets.every((entry) => typeof entry === 'string' && entry.trim() !== '')))
  )
}

export function isWorkspaceSummary(value: unknown): value is WorkspaceSummary {
  const item = object(value)
  return (
    item !== undefined &&
    typeof item.id === 'string' &&
    item.id.trim() !== '' &&
    typeof item.name === 'string' &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string' &&
    Number.isSafeInteger(item.sessionCount) &&
    (item.sessionCount as number) >= 0 &&
    (item.path === undefined || typeof item.path === 'string') &&
    (item.sessionIds === undefined ||
      (Array.isArray(item.sessionIds) &&
        item.sessionIds.every((sessionId) => typeof sessionId === 'string' && sessionId.trim() !== '')))
  )
}

export function readPersistedWebviewState(value: unknown): PersistedWebviewState {
  const root = object(value)
  const raw = object(root?.composerPreferences)
  const model = normalizedModelSelection(raw?.model)
  const openFileId =
    typeof raw?.openFileId === 'string' && raw.openFileId.trim() !== '' ? raw.openFileId : undefined
  const promptMode =
    typeof raw?.promptMode === 'string' && isPromptMode(raw.promptMode) ? raw.promptMode : undefined
  return {
    version: 1,
    composerPreferences: {
      ...(model === undefined ? {} : { model }),
      ...(openFileId === undefined ? {} : { openFileId }),
      ...(promptMode === undefined ? {} : { promptMode }),
    },
    ...(typeof root?.activeSessionId === 'string' && root.activeSessionId.trim() !== ''
      ? { activeSessionId: root.activeSessionId }
      : {}),
  }
}
