import type { SessionSummary, SubagentCatalog, SubagentHistoryPage, SubagentView } from '@dsh-vscode/domain'
import { translate } from '../../i18n.js'
import { optionalSequence } from './history-replay.js'
import { object } from './unknown-record.js'

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

export function parseSubagentHistory(value: unknown): SubagentHistoryPage {
  const page = object(value)
  if (
    page === undefined ||
    !Array.isArray(page.events) ||
    !page.events.every(isSubagentHistoryEvent) ||
    typeof page.hasMore !== 'boolean'
  )
    throw new Error(translate('app.error.malformedHistory'))
  const projection = object(page.projection)
  if (
    page.projection !== undefined &&
    (projection === undefined ||
      !Number.isSafeInteger(projection.asOfSequence) ||
      (projection.asOfSequence as number) < -1 ||
      object(projection.values) === undefined)
  )
    throw new Error(translate('app.error.malformedProjection'))
  const hasBeforeSequence = Object.hasOwn(page, 'beforeSeq')
  const parsedBeforeSequence = optionalSequence(page.beforeSeq)
  if (hasBeforeSequence && parsedBeforeSequence === undefined)
    throw new Error(translate('app.error.malformedHistory'))
  return {
    events: page.events,
    hasMore: page.hasMore,
    ...(parsedBeforeSequence === undefined ? {} : { beforeSequence: parsedBeforeSequence }),
    ...(projection === undefined
      ? {}
      : {
          projection: {
            asOfSequence: projection.asOfSequence as number,
            values: projection.values as Readonly<Record<string, unknown>>,
          },
        }),
  }
}

export function isSubagentHistoryEvent(value: unknown): value is SubagentHistoryPage['events'][number] {
  const entry = object(value)
  const event = object(entry?.event)
  return (
    entry !== undefined &&
    Number.isSafeInteger(entry.sequence) &&
    typeof entry.time === 'string' &&
    event !== undefined &&
    typeof event.type === 'string'
  )
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
    (item.mode === 'one-shot' || item.mode === 'continuable') &&
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
