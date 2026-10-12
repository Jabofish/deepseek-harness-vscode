import type {
  BackendEvent,
  SessionProjectionSnapshot,
  SessionHistoryEvent,
  SessionStatus,
  SessionSummary,
} from '@dsh-vscode/domain'
import { asRecord, firstString } from './configuration.js'
import { sessionListFactsFromHistory } from './history.js'

type SummaryKey = 'title' | 'agentPreset' | 'sessionListMetadata'
interface Cell {
  readonly value: unknown
  readonly sequence?: number
}
interface Entry {
  summary?: SessionSummary
  status?: SessionStatus
  statusRevision: number
  listRequest: number
  nonblank: boolean
  activityAt?: number
  readonly cells: Map<SummaryKey, Cell>
}
interface ListRead {
  readonly request: number
  readonly runtimeRevision: number
}

/** Durable projection cells and live runtime status have different clocks. */
export class SessionSummaryCache {
  private readonly entries = new Map<string, Entry>()
  private runtimeRevision = 0
  private listRequest = 0

  public beginList(): ListRead {
    return { request: ++this.listRequest, runtimeRevision: this.runtimeRevision }
  }

  public get(sessionId: string): SessionSummary | undefined {
    return this.entries.get(sessionId)?.summary
  }

  public rememberList(summary: SessionSummary, read: ListRead): SessionSummary {
    const entry = this.entry(summary.id)
    if (read.request < entry.listRequest) return entry.summary ?? summary
    entry.listRequest = read.request
    // Only a list started after the last status event can rebaseline it.
    if (entry.statusRevision <= read.runtimeRevision) entry.status = summary.status
    this.projection(entry, summary.projection)
    return this.store(entry, summary)
  }

  public rememberHistory(
    summary: SessionSummary,
    projection: SessionProjectionSnapshot | undefined,
    history: readonly SessionHistoryEvent[],
    rawHistory: readonly unknown[],
  ): SessionSummary {
    const entry = this.entry(summary.id)
    const facts = sessionListFactsFromHistory(history, rawHistory)
    entry.nonblank ||= facts.nonblank
    if (facts.lastPromptAt !== undefined)
      entry.activityAt = Math.max(entry.activityAt ?? 0, facts.lastPromptAt)
    this.projection(entry, projection)
    return this.store(entry, entry.summary ?? summary)
  }

  public remember(event: BackendEvent): void {
    if (event.type === 'session.removed') {
      this.entries.delete(event.sessionId)
      return
    }
    if (event.type === 'session.projection.baseline') {
      for (const [id, projection] of Object.entries(event.projections)) {
        const entry = this.entry(id)
        this.projection(entry, projection)
        if (entry.summary !== undefined) this.store(entry, entry.summary)
      }
      return
    }
    if (!('sessionId' in event)) return
    const entry = this.entries.get(event.sessionId)
    if (event.type === 'session.status') {
      if (!isStatus(event.status)) return
      const current = entry ?? this.entry(event.sessionId)
      current.status = event.status
      current.statusRevision = ++this.runtimeRevision
      if (current.summary !== undefined) this.store(current, current.summary)
      return
    }
    if (
      event.type === 'session.subscribed' ||
      event.type === 'session.projection' ||
      event.type === 'session.activity' ||
      event.type === 'session.title' ||
      event.type === 'session.configuration' ||
      event.type === 'turn.started'
    ) {
      const current = entry ?? this.entry(event.sessionId)
      if (event.type === 'session.subscribed') this.projection(current, event.projection)
      else if (event.type === 'session.projection' && isSummaryKey(event.key))
        this.cell(current, event.key, event.value, event.sequence)
      else if (event.type === 'session.title') this.cell(current, 'title', event.title, event.sequence)
      else if (event.type === 'session.configuration' && event.patch.preset !== undefined)
        this.cell(current, 'agentPreset', event.patch.preset, event.sequence)
      else if (event.type === 'session.activity' && validTime(event.updatedAt))
        current.activityAt = Math.max(current.activityAt ?? 0, event.updatedAt)
      else if (event.type === 'turn.started') current.nonblank = true
      if (current.summary !== undefined) this.store(current, current.summary)
    }
  }

  private entry(sessionId: string): Entry {
    let entry = this.entries.get(sessionId)
    if (entry === undefined) {
      entry = { statusRevision: 0, listRequest: 0, nonblank: false, cells: new Map() }
      this.entries.set(sessionId, entry)
    }
    return entry
  }

  private projection(entry: Entry, projection: SessionProjectionSnapshot | undefined): void {
    if (projection === undefined) return
    for (const [key, value] of Object.entries(projection.values))
      if (isSummaryKey(key)) this.cell(entry, key, value, projection.asOfSequence)
  }

  private cell(entry: Entry, key: SummaryKey, value: unknown, sequence?: number): void {
    if (
      key === 'sessionListMetadata'
        ? metadata(value) === undefined
        : key === 'agentPreset'
          ? value !== null && firstString(value) === undefined
          : firstString(value) === undefined
    )
      return
    const previous = entry.cells.get(key)
    if (
      sequence !== undefined &&
      previous?.sequence !== undefined &&
      previous.sequence >= 0 &&
      sequence <= previous.sequence
    )
      return
    // Unsequenced live facts must not erase the last known durable watermark;
    // a delayed baseline at that cut still predates the fact we just observed.
    const watermark = sequence ?? previous?.sequence
    entry.cells.set(key, { value, ...(watermark === undefined ? {} : { sequence: watermark }) })
  }

  private store(entry: Entry, summary: SessionSummary): SessionSummary {
    const facts = metadata(entry.cells.get('sessionListMetadata')?.value)
    entry.nonblank ||= !summary.blank || facts?.blank === false
    const updatedAt =
      facts === undefined
        ? Date.parse(summary.updatedAt)
        : // Without a cached list, createdAt may be the first event of a partial
          // history page. It must not displace the projected human-prompt time.
          (facts.lastPromptAt ?? Date.parse(summary.createdAt))
    const next = {
      ...summary,
      title: firstString(entry.cells.get('title')?.value) ?? summary.title,
      blank: !entry.nonblank && (facts?.blank ?? summary.blank),
      status: entry.status ?? summary.status,
      updatedAt: new Date(Math.max(updatedAt, entry.activityAt ?? 0)).toISOString(),
    }
    const preset = entry.cells.get('agentPreset')
    const projectedPreset = firstString(preset?.value)
    if (preset?.value === null) delete next.agentPreset
    else if (projectedPreset !== undefined) next.agentPreset = projectedPreset
    entry.summary = next
    return next
  }
}

function isSummaryKey(key: string): key is SummaryKey {
  return key === 'title' || key === 'agentPreset' || key === 'sessionListMetadata'
}

function isStatus(value: string): value is SessionStatus {
  return (
    value === 'idle' ||
    value === 'running' ||
    value === 'awaiting-input' ||
    value === 'failed' ||
    value === 'completed'
  )
}

function validTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    Number.isFinite(new Date(value).getTime())
  )
}

function metadata(
  value: unknown,
): { readonly blank: boolean; readonly lastPromptAt: number | null } | undefined {
  const record = asRecord(value)
  if (typeof record.blank !== 'boolean' || (record.lastPromptAt !== null && !validTime(record.lastPromptAt)))
    return undefined
  return { blank: record.blank, lastPromptAt: record.lastPromptAt }
}
