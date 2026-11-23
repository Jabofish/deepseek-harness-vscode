import {
  matchesQuestionResolution,
  type BackendEvent,
  type SubagentLiveActivity,
  type UserQuestion,
} from '@dsh-vscode/domain'

const MAX_TRACKED_SESSIONS = 128
const MAX_KNOWN_SUBAGENTS = 512
const MAX_ACTIVE_TOOLS_PER_SESSION = 32
const MAX_TOOL_NAME_CHARS = 80

const LIVE_SESSION_STATUSES = new Set(['running', 'awaiting-input'])

interface TrackedSessionActivity {
  readonly activeTools: Map<string, string>
  readonly preparingTools: Map<string, string>
  readonly pendingPermissions: Map<string, true>
  readonly pendingQuestions: Map<
    string,
    Pick<UserQuestion, 'sessionId' | 'id' | 'rpcId' | 'callId'> & {
      readonly items?: readonly { readonly id: string }[]
    }
  >
  streamPhase: 'thinking' | 'responding' | undefined
}

export interface SubagentActivityTrackerOptions {
  /** Authoritative parent lookup from the active backend's subagent repository. */
  readonly isSubagent?: (sessionId: string) => boolean
}

/**
 * Derives bounded, safe structured live-activity headings for running subagent
 * sessions from the Host's existing backend event stream.
 *
 * State is tracked in memory for any active session so events that arrive
 * slightly before `subagent.list` commits still surface immediately once the
 * child is recognized, while wire updates are emitted exclusively for known
 * subagent sessions and only when the visible activity changes.
 */
export class SubagentActivityTracker {
  private readonly sessions = new Map<string, TrackedSessionActivity>()
  private readonly knownSubagents = new Set<string>()
  private readonly published = new Map<string, SubagentLiveActivity>()

  public constructor(private readonly options: SubagentActivityTrackerOptions = {}) {}

  /** Mark one child session id as a known subagent and return its live snapshot if active. */
  public markSubagent(sessionId: string): SubagentLiveActivity | undefined {
    if (sessionId.trim() === '') return undefined
    this.rememberSubagent(sessionId)
    return this.publishIfChanged(sessionId)
  }

  /** Current non-idle live activity snapshots for all known subagents (for surface replay). */
  public snapshots(): readonly SubagentLiveActivity[] {
    const result: SubagentLiveActivity[] = []
    for (const [sessionId, activity] of this.published) {
      if (activity.phase !== 'idle' && this.isKnownSubagent(sessionId)) result.push(activity)
    }
    return result
  }

  /** Clear all tracked activity on disconnect, backend replacement, or disposal. */
  public reset(): void {
    this.sessions.clear()
    this.knownSubagents.clear()
    this.published.clear()
  }

  /**
   * Observe one structured backend event. Returns a changed live-activity update
   * when a known subagent's visible heading transitions, or `undefined` otherwise.
   */
  public observe(event: BackendEvent): SubagentLiveActivity | undefined {
    if (event.replayed === true && event.type !== 'subagent.catalog.updated') return undefined
    switch (event.type) {
      case 'subagent.catalog.updated':
        return event.entry.mode === 'one-shot' || event.entry.mode === 'continuable'
          ? this.markSubagent(event.entry.id)
          : undefined
      case 'session.added':
        if (event.origin === 'subagent') return this.markSubagent(event.sessionId)
        return undefined
      case 'connection.lost':
        this.reset()
        return undefined
      case 'session.removed': {
        this.sessions.delete(event.sessionId)
        const wasPublished = this.published.delete(event.sessionId)
        const wasKnown = this.knownSubagents.delete(event.sessionId)
        return wasPublished && wasKnown ? { sessionId: event.sessionId, phase: 'idle' } : undefined
      }
      case 'tool.preparing': {
        const entry = this.touchSession(event.sessionId)
        setBoundedMap(entry.preparingTools, event.callId, safeToolName(event.toolName))
        return this.publishIfChanged(event.sessionId)
      }
      case 'tool.updated': {
        const entry = this.touchSession(event.sessionId)
        if (event.tool.preparation !== undefined) {
          setBoundedMap(entry.preparingTools, event.tool.id, safeToolName(event.tool.name))
          return this.publishIfChanged(event.sessionId)
        }
        entry.preparingTools.delete(event.tool.id)
        if (event.tool.status === 'queued' || event.tool.status === 'running') {
          setBoundedMap(entry.activeTools, event.tool.id, safeToolName(event.tool.name))
        } else {
          entry.activeTools.delete(event.tool.id)
        }
        return this.publishAndPrune(event.sessionId)
      }
      case 'reasoning.delta': {
        if (event.delta === '') return undefined
        const entry = this.touchSession(event.sessionId)
        entry.streamPhase = 'thinking'
        return this.publishIfChanged(event.sessionId)
      }
      case 'message.delta': {
        if (event.delta === '') return undefined
        const entry = this.touchSession(event.sessionId)
        entry.streamPhase = 'responding'
        return this.publishIfChanged(event.sessionId)
      }
      case 'message.completed': {
        const entry = this.sessions.get(event.sessionId)
        if (entry === undefined) return undefined
        entry.streamPhase = undefined
        entry.preparingTools.clear()
        return this.publishAndPrune(event.sessionId)
      }
      case 'permission.requested': {
        const entry = this.touchSession(event.request.sessionId)
        setBoundedMap(entry.pendingPermissions, event.request.id, true)
        return this.publishIfChanged(event.request.sessionId)
      }
      case 'permission.resolved': {
        const entry = this.sessions.get(event.sessionId)
        if (entry === undefined) return undefined
        entry.pendingPermissions.delete(event.requestId)
        return this.publishAndPrune(event.sessionId)
      }
      case 'question.requested': {
        const entry = this.touchSession(event.question.sessionId)
        const key = event.question.callId ?? event.question.rpcId ?? event.question.id
        setBoundedMap(entry.pendingQuestions, key, {
          sessionId: event.question.sessionId,
          id: event.question.id,
          ...(event.question.rpcId === undefined ? {} : { rpcId: event.question.rpcId }),
          ...(event.question.callId === undefined ? {} : { callId: event.question.callId }),
          ...(event.question.items === undefined
            ? {}
            : { items: event.question.items.map(({ id }) => ({ id })) }),
        })
        return this.publishIfChanged(event.question.sessionId)
      }
      case 'question.resolved': {
        const entry = this.sessions.get(event.sessionId)
        if (entry === undefined) return undefined
        for (const [key, pending] of entry.pendingQuestions)
          if (
            matchesQuestionResolution(pending, event) ||
            (event.settledCallId !== undefined && pending.callId === event.settledCallId)
          )
            entry.pendingQuestions.delete(key)
        return this.publishAndPrune(event.sessionId)
      }
      case 'turn.ended': {
        this.sessions.delete(event.sessionId)
        return this.publishIfChanged(event.sessionId)
      }
      case 'session.status': {
        if (LIVE_SESSION_STATUSES.has(event.status)) return undefined
        this.sessions.delete(event.sessionId)
        return this.publishIfChanged(event.sessionId)
      }
      default:
        return undefined
    }
  }

  private rememberSubagent(sessionId: string): void {
    if (this.knownSubagents.has(sessionId)) {
      this.knownSubagents.delete(sessionId)
    } else if (this.knownSubagents.size >= MAX_KNOWN_SUBAGENTS) {
      const oldest = this.knownSubagents.values().next().value
      if (oldest !== undefined) {
        this.knownSubagents.delete(oldest)
        this.published.delete(oldest)
      }
    }
    this.knownSubagents.add(sessionId)
  }

  private isKnownSubagent(sessionId: string): boolean {
    if (this.knownSubagents.has(sessionId)) return true
    if (this.options.isSubagent?.(sessionId) === true) {
      this.rememberSubagent(sessionId)
      return true
    }
    return false
  }

  private touchSession(sessionId: string): TrackedSessionActivity {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest !== undefined) {
        this.sessions.delete(oldest)
        this.published.delete(oldest)
      }
    }
    const created: TrackedSessionActivity = {
      activeTools: new Map(),
      preparingTools: new Map(),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      streamPhase: undefined,
    }
    this.sessions.set(sessionId, created)
    return created
  }

  private publishAndPrune(sessionId: string): SubagentLiveActivity | undefined {
    const entry = this.sessions.get(sessionId)
    if (
      entry !== undefined &&
      entry.activeTools.size === 0 &&
      entry.preparingTools.size === 0 &&
      entry.pendingPermissions.size === 0 &&
      entry.pendingQuestions.size === 0 &&
      entry.streamPhase === undefined
    ) {
      this.sessions.delete(sessionId)
    }
    return this.publishIfChanged(sessionId)
  }

  private publishIfChanged(sessionId: string): SubagentLiveActivity | undefined {
    if (!this.isKnownSubagent(sessionId)) return undefined
    const next = this.derive(sessionId)
    const previous = this.published.get(sessionId)
    if (sameActivity(previous, next)) return undefined
    if (next.phase === 'idle') {
      if (previous === undefined) return undefined
      this.published.delete(sessionId)
      return next
    }
    this.published.set(sessionId, next)
    return next
  }

  private derive(sessionId: string): SubagentLiveActivity {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return { sessionId, phase: 'idle' }
    if (entry.pendingPermissions.size > 0) return { sessionId, phase: 'awaiting-approval' }
    if (entry.pendingQuestions.size > 0) return { sessionId, phase: 'awaiting-question' }
    if (entry.activeTools.size > 0) {
      const toolName = lastMapValue(entry.activeTools)
      return {
        sessionId,
        phase: 'tool',
        ...(toolName === undefined ? {} : { toolName }),
        activeToolCount: entry.activeTools.size,
      }
    }
    if (entry.preparingTools.size > 0) {
      const toolName = lastMapValue(entry.preparingTools)
      return {
        sessionId,
        phase: 'preparing-tool',
        ...(toolName === undefined ? {} : { toolName }),
      }
    }
    if (entry.streamPhase !== undefined) return { sessionId, phase: entry.streamPhase }
    return { sessionId, phase: 'idle' }
  }
}

function safeToolName(name: string): string {
  return name.length <= MAX_TOOL_NAME_CHARS && /^[a-z0-9_][a-z0-9_.:-]*$/iu.test(name) ? name : ''
}

function setBoundedMap<Value>(map: Map<string, Value>, key: string, value: Value): void {
  if (map.has(key)) map.delete(key)
  else if (map.size >= MAX_ACTIVE_TOOLS_PER_SESSION) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

function lastMapValue(map: ReadonlyMap<string, string>): string | undefined {
  let latest: string | undefined
  for (const value of map.values()) if (value !== '') latest = value
  return latest
}

function sameActivity(left: SubagentLiveActivity | undefined, right: SubagentLiveActivity): boolean {
  if (left === undefined) return right.phase === 'idle'
  return (
    left.phase === right.phase &&
    left.toolName === right.toolName &&
    left.activeToolCount === right.activeToolCount
  )
}
