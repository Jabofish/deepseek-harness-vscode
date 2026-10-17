import type {
  SessionSummary,
  SubagentCatalog,
  SubagentView,
  SessionProjectionSnapshot,
} from '@dsh-vscode/domain'
import { parseSessionProjection } from './event-values.js'
import { translate } from '../../i18n.js'
import { object } from './unknown-record.js'
import { parseTranscript } from './transcript-state.js'
import type { TranscriptWindow } from '@dsh-vscode/webview-protocol'

export function parseSubagentCatalog(value: unknown): SubagentCatalog {
  const catalog = object(value)
  if (
    catalog === undefined ||
    !Array.isArray(catalog.entries) ||
    !catalog.entries.every(isSubagentCatalogEntry) ||
    typeof catalog.parentAvailable !== 'boolean'
  )
    throw new Error(translate('app.error.malformedCatalog'))
  return {
    entries: catalog.entries,
    parentAvailable: catalog.parentAvailable,
  }
}

export function parseSubagentHistory(value: unknown): {
  readonly transcript: TranscriptWindow
  readonly projection?: SessionProjectionSnapshot
} {
  const page = object(value)
  if (page === undefined) throw new Error(translate('app.error.malformedHistory'))
  const transcript = parseTranscript(page.transcript)
  const projection = parseSessionProjection(page.projection)
  return { transcript, ...(projection === undefined ? {} : { projection }) }
}

export function isSubagentView(value: unknown): value is SubagentView {
  const item = object(value)
  return (
    item !== undefined &&
    item.kind === 'child' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    (item.label === undefined || typeof item.label === 'string') &&
    (item.mode !== 'continuable' || typeof item.label === 'string') &&
    (item.activity === 'running' || item.activity === 'inactive') &&
    typeof item.parentSessionId === 'string' &&
    item.parentSessionId.length > 0 &&
    (item.mode === 'one-shot' || item.mode === 'continuable' || item.mode === 'external') &&
    typeof item.hasChildren === 'boolean'
  )
}

export function isSubagentCatalogEntry(value: unknown): value is SubagentCatalog['entries'][number] {
  if (isSubagentView(value)) return true
  const item = object(value)
  return (
    item !== undefined &&
    item.kind === 'diagnostic' &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.parentSessionId === 'string' &&
    item.parentSessionId.length > 0 &&
    (item.reason === 'corrupt' || item.reason === 'unsupported' || item.reason === 'unavailable')
  )
}

export function nextForkTitle(
  sourceTitle: string,
  sessions: readonly SessionSummary[],
  workspaceId: string,
): string {
  const base = sourceTitle.trim() === '' ? 'New Session' : sourceTitle.trim()
  const taken = new Set(
    sessions
      .filter((session) => session.workspaceId === workspaceId)
      .map((session) => session.title.trim().toLocaleLowerCase()),
  )
  let suffix = 1
  let candidate = `${base} (${suffix})`
  while (taken.has(candidate.toLocaleLowerCase())) {
    suffix += 1
    candidate = `${base} (${suffix})`
  }
  return candidate
}
