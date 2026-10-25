import type { BackendEvent, DshBackend } from '@dsh-vscode/domain'

/**
 * How long a followed session survives its last follow reason. Reopening
 * inside the window reuses the live stream; after it, the next open reloads
 * history and re-baselines through the normal `session.open` path.
 */
export const SESSION_UNWATCH_DELAY_MS = 30_000

/** A session stays followed while its agent turn or account-level input is pending. */
const FOLLOWED_STATUSES = new Set(['running', 'awaiting-input'])

/** Job row states that must keep publishing progress after the panel closes. */
const ACTIVE_JOB_STATUSES = new Set(['running', 'stopping'])

interface PendingInteraction {
  readonly kind: 'permission' | 'question'
  readonly requestId?: string
  readonly rpcId?: string
}

interface SessionWatchRecord {
  /** Surfaces whose panel currently displays this session. */
  readonly displayedBy: Set<string>
  /** Latest host-wide status fact; `undefined` while unobserved. */
  status: string | undefined
  /** Live permission/question requests awaiting a user answer. */
  readonly pendingInteractions: Map<string, PendingInteraction>
  runningJobs: boolean
  /**
   * A follow stream is (or was) established for this session. Set by this
   * coordinator and by every observed `session.subscribed`, so opportunistically
   * started streams (queue baseline reads) are also reclaimed.
   */
  followIntent: boolean
  /** The conversation stream was released while Job rows stayed alive. */
  jobRowsOnly: boolean
  unwatchTimer: ReturnType<typeof setTimeout> | undefined
}

export interface SessionWatchControllerDependencies {
  readonly delayMs?: number
  /**
   * Seed follow reasons from the session directory after each attach. The
   * default reads `sessions.list`; a failure keeps the policy event-driven.
   */
  readonly readDirectory?: (
    backend: DshBackend,
    signal: AbortSignal,
  ) => Promise<readonly { readonly id: string; readonly status: string }[]>
}

export interface SessionWatchController {
  /** A surface's panel started displaying this session. */
  surfaceDisplaysSession(this: void, surfaceId: string, sessionId: string, visible?: boolean): void
  surfaceCapacityChanged(this: void, surfaceId: string, ready: boolean): void
  surfaceVisibilityChanged(this: void, surfaceId: string, visible: boolean): void
  /** A surface closed or stopped displaying its session. */
  surfaceReleased(this: void, surfaceId: string): void
  attach(this: void, backend: DshBackend): void
  detach(this: void): void
  dispose(this: void): void
}

/**
 * Session follow lifecycle for per-session-stream backends (issue #13).
 *
 * The adapter opens one durable follow stream per watched session, and each
 * stream replays the session's bounded history on connect. Following every
 * session in a workspace starves the transport heartbeat, so the follow set is
 * bounded to what the user can see or act on: sessions displayed in a panel,
 * sessions with a running turn or pending interaction. Completed or merely
 * catalogued child sessions do not replay their histories. Job row streams
 * additionally survive while background jobs are running. Sessions outside the set are unfollowed after a delay; the
 * normal open path reloads history and re-baselines the stream.
 *
 * Backends without optional `watchSession`/`unwatchSession` carry every session
 * on one shared stream; display tracking still runs but has nothing to release.
 */
export function createSessionWatchController(
  deps: SessionWatchControllerDependencies = {},
): SessionWatchController {
  const delayMs = deps.delayMs ?? SESSION_UNWATCH_DELAY_MS
  const readDirectory =
    deps.readDirectory ??
    ((backend, signal) =>
      backend.sessions
        .list(undefined, signal)
        .then((page) => page.items.map(({ id, status }) => ({ id, status }))))
  /** Panel display state; surfaces outlive backend reattachment. */
  const displayedBySurface = new Map<string, string>()
  const visibleSurfaces = new Set<string>()
  const blockedSurfaces = new Set<string>()
  const records = new Map<string, SessionWatchRecord>()
  let backend: DshBackend | undefined
  let unsubscribe: (() => void) | undefined
  let seedController: AbortController | undefined
  let seedChanges: { readonly statuses: Set<string>; readonly jobs: Set<string> } | undefined
  const removed = new Set<string>()
  const archived = new Set<string>()

  const record = (sessionId: string): SessionWatchRecord => {
    const existing = records.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionWatchRecord = {
      displayedBy: new Set<string>(),
      status: undefined,
      pendingInteractions: new Map<string, PendingInteraction>(),
      runningJobs: false,
      followIntent: false,
      jobRowsOnly: false,
      unwatchTimer: undefined,
    }
    records.set(sessionId, created)
    return created
  }

  const isDisplayed = (sessionId: string): boolean => {
    return (records.get(sessionId)?.displayedBy.size ?? 0) > 0
  }

  const isFollowed = (sessionId: string): boolean => {
    if (removed.has(sessionId) || archived.has(sessionId)) return false
    if (isDisplayed(sessionId)) return true
    const entry = records.get(sessionId)
    if (entry === undefined) return false
    if (
      (entry.status !== undefined && FOLLOWED_STATUSES.has(entry.status)) ||
      entry.pendingInteractions.size > 0
    )
      return true
    return false
  }

  const watch = (sessionId: string): void => {
    if (backend?.events.watchSession === undefined || removed.has(sessionId) || archived.has(sessionId))
      return
    const entry = record(sessionId)
    const needsWatch = entry.jobRowsOnly || !entry.followIntent
    entry.followIntent = true
    entry.jobRowsOnly = false
    if (needsWatch) backend.events.watchSession(sessionId)
  }

  const release = (sessionId: string): void => {
    const entry = records.get(sessionId)
    if (entry === undefined) return
    backend?.events.unwatchSession?.(sessionId, { keepJobRows: entry.runningJobs })
    if (entry.runningJobs) {
      entry.followIntent = true
      entry.jobRowsOnly = true
      return
    }
    records.delete(sessionId)
  }

  const cancelTimer = (entry: SessionWatchRecord): void => {
    if (entry.unwatchTimer === undefined) return
    clearTimeout(entry.unwatchTimer)
    entry.unwatchTimer = undefined
  }

  /** Re-evaluate only the session whose demand changed. */
  const evaluate = (sessionId: string): void => {
    const entry = records.get(sessionId)
    if (entry === undefined) return
    backend?.events.setSessionPreview?.(
      sessionId,
      [...entry.displayedBy].some((surfaceId) => !blockedSurfaces.has(surfaceId)),
    )
    if (isFollowed(sessionId)) {
      cancelTimer(entry)
      watch(sessionId)
      return
    }
    // Job rows that just settled close immediately; a still-running job set
    // keeps only its Job stream when the delayed release fires.
    if (entry.jobRowsOnly) {
      cancelTimer(entry)
      if (!entry.runningJobs) release(sessionId)
      return
    }
    if (backend !== undefined && entry.followIntent && entry.unwatchTimer === undefined)
      entry.unwatchTimer = setTimeout(() => {
        entry.unwatchTimer = undefined
        if (records.get(sessionId) !== entry) return
        if (!isFollowed(sessionId)) release(sessionId)
      }, delayMs)
  }

  const resolveInteractions = (sessionId: string, match: (pending: PendingInteraction) => boolean): void => {
    const entry = records.get(sessionId)
    if (entry === undefined) return
    let changed = false
    for (const [key, pending] of entry.pendingInteractions)
      if (match(pending)) {
        entry.pendingInteractions.delete(key)
        changed = true
      }
    if (changed) evaluate(sessionId)
  }

  const acceptEvent = (event: BackendEvent): void => {
    switch (event.type) {
      case 'session.subscribed':
        // Every established follow stream announces itself, including streams
        // opportunistically started by repository reads.
        if (removed.has(event.sessionId) || archived.has(event.sessionId)) return
        record(event.sessionId).followIntent = true
        record(event.sessionId).jobRowsOnly = false
        evaluate(event.sessionId)
        return
      case 'session.status':
        if (removed.has(event.sessionId) || archived.has(event.sessionId)) return
        seedChanges?.statuses.add(event.sessionId)
        if (!records.has(event.sessionId) && !FOLLOWED_STATUSES.has(event.status)) return
        record(event.sessionId).status = event.status
        evaluate(event.sessionId)
        return
      case 'permission.requested':
        if (removed.has(event.request.sessionId) || archived.has(event.request.sessionId)) return
        record(event.request.sessionId).pendingInteractions.set(`permission:${event.request.id}`, {
          kind: 'permission',
          requestId: event.request.id,
        })
        evaluate(event.request.sessionId)
        return
      case 'permission.resolved':
        resolveInteractions(
          event.sessionId,
          (pending) => pending.kind === 'permission' && pending.requestId === event.requestId,
        )
        return
      case 'question.requested':
        if (removed.has(event.question.sessionId) || archived.has(event.question.sessionId)) return
        record(event.question.sessionId).pendingInteractions.set(`question:${event.question.id}`, {
          kind: 'question',
          requestId: event.question.id,
          ...(event.question.rpcId === undefined ? {} : { rpcId: event.question.rpcId }),
        })
        evaluate(event.question.sessionId)
        return
      case 'question.resolved':
        // A resolution naming neither the local id nor the rpc id is the only
        // form that may sweep the session's pending questions.
        resolveInteractions(
          event.sessionId,
          (pending) =>
            pending.kind === 'question' &&
            ((event.questionId === undefined && event.questionRpcId === undefined) ||
              (event.questionId !== undefined && pending.requestId === event.questionId) ||
              (event.questionRpcId !== undefined && pending.rpcId === event.questionRpcId)),
        )
        return
      case 'jobs.updated': {
        if (removed.has(event.sessionId) || archived.has(event.sessionId)) return
        seedChanges?.jobs.add(event.sessionId)
        const running = event.jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.status))
        if (!running && !records.has(event.sessionId)) return
        const entry = record(event.sessionId)
        entry.runningJobs = running
        if (running && !entry.followIntent) watch(event.sessionId)
        evaluate(event.sessionId)
        return
      }
      case 'session.added': {
        removed.delete(event.sessionId)
        seedChanges?.statuses.add(event.sessionId)
        evaluate(event.sessionId)
        return
      }
      case 'subagent.catalog.updated': {
        // Catalogue membership alone is not a reason to replay a child's history.
        // Running children publish the same host-wide status as ordinary sessions.
        return
      }
      case 'session.removed': {
        // The adapter closes a removed session's streams itself; forgetting the
        // policy state keeps a recycled id from inheriting stale follow reasons.
        removed.add(event.sessionId)
        seedChanges?.statuses.add(event.sessionId)
        seedChanges?.jobs.add(event.sessionId)
        const entry = records.get(event.sessionId)
        if (entry !== undefined) cancelTimer(entry)
        records.delete(event.sessionId)
        for (const [surfaceId, sessionId] of displayedBySurface)
          if (sessionId === event.sessionId) {
            displayedBySurface.delete(surfaceId)
            blockedSurfaces.delete(surfaceId)
            visibleSurfaces.delete(surfaceId)
          }
        backend?.events.unwatchSession?.(event.sessionId)
        return
      }
      case 'connection.restored':
        seed()
        return
      case 'connection.lost':
        // These waterfall bindings belonged to the disconnected event client.
        // A new client replays live requests; stale ids cannot pin sessions forever.
        seedController?.abort()
        for (const [sessionId, entry] of records) {
          entry.pendingInteractions.clear()
          evaluate(sessionId)
        }
        return
      case 'archived.sessions.changed': {
        archived.clear()
        for (const sessionId of event.sessionIds) archived.add(sessionId)
        for (const [sessionId, entry] of records) {
          if (archived.has(sessionId)) {
            cancelTimer(entry)
            entry.followIntent = false
            entry.jobRowsOnly = false
            entry.runningJobs = false
            entry.pendingInteractions.clear()
            entry.displayedBy.clear()
            backend?.events.unwatchSession?.(sessionId)
            records.delete(sessionId)
          } else evaluate(sessionId)
        }
        for (const [surfaceId, sessionId] of displayedBySurface)
          if (archived.has(sessionId)) {
            displayedBySurface.delete(surfaceId)
            blockedSurfaces.delete(surfaceId)
            visibleSurfaces.delete(surfaceId)
          }
        return
      }
      default:
        return
    }
  }

  const clearBackendState = (): void => {
    seedController?.abort()
    seedController = undefined
    seedChanges = undefined
    unsubscribe?.()
    unsubscribe = undefined
    backend = undefined
    for (const entry of records.values()) cancelTimer(entry)
    records.clear()
    removed.clear()
    archived.clear()
  }

  /** Reconcile status and cheap Job row snapshots without reading session histories. */
  const seed = (): void => {
    const attached = backend
    if (attached?.events.watchSession === undefined || attached.events.unwatchSession === undefined) return
    seedController?.abort()
    const controller = new AbortController()
    const changes = { statuses: new Set<string>(), jobs: new Set<string>() }
    seedController = controller
    seedChanges = changes
    const current = (): boolean => backend === attached && !controller.signal.aborted
    void readDirectory(attached, controller.signal)
      .then(async (items) => {
        if (!current()) return
        for (const item of items) {
          if (removed.has(item.id) || archived.has(item.id) || changes.statuses.has(item.id)) continue
          if (FOLLOWED_STATUSES.has(item.status) || records.has(item.id)) {
            record(item.id).status = item.status
            evaluate(item.id)
          }
        }
        if (typeof attached.jobs?.list !== 'function') return
        let offset = 0
        const worker = async (): Promise<void> => {
          for (;;) {
            if (!current()) return
            const item = items[offset++]
            if (item === undefined) return
            if (removed.has(item.id) || archived.has(item.id)) continue
            try {
              const jobs = await attached.jobs.list(item.id, controller.signal)
              if (!current()) return
              if (!removed.has(item.id) && !archived.has(item.id) && !changes.jobs.has(item.id))
                acceptEvent({ type: 'jobs.updated', sessionId: item.id, jobs })
            } catch {
              /* Optional Jobs are unavailable on older backends. */
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker))
      })
      .catch(() => undefined)
      .finally(() => {
        if (seedController === controller) {
          seedController = undefined
          seedChanges = undefined
        }
      })
  }

  return {
    surfaceDisplaysSession: (surfaceId, sessionId, visible = true) => {
      removed.delete(sessionId)
      const previous = displayedBySurface.get(surfaceId)
      if (previous === sessionId && visibleSurfaces.has(surfaceId) === visible) return
      if (previous !== undefined) records.get(previous)?.displayedBy.delete(surfaceId)
      displayedBySurface.set(surfaceId, sessionId)
      if (visible) {
        visibleSurfaces.add(surfaceId)
        record(sessionId).displayedBy.add(surfaceId)
      } else {
        visibleSurfaces.delete(surfaceId)
        records.get(sessionId)?.displayedBy.delete(surfaceId)
      }
      evaluate(sessionId)
      if (previous !== undefined) evaluate(previous)
    },
    surfaceCapacityChanged: (surfaceId, ready) => {
      if (ready) blockedSurfaces.delete(surfaceId)
      else blockedSurfaces.add(surfaceId)
      const sessionId = displayedBySurface.get(surfaceId)
      if (sessionId !== undefined) evaluate(sessionId)
    },
    surfaceVisibilityChanged: (surfaceId, visible) => {
      const sessionId = displayedBySurface.get(surfaceId)
      if (sessionId === undefined) return
      if (visible) {
        visibleSurfaces.add(surfaceId)
        record(sessionId).displayedBy.add(surfaceId)
      } else {
        visibleSurfaces.delete(surfaceId)
        records.get(sessionId)?.displayedBy.delete(surfaceId)
      }
      evaluate(sessionId)
    },
    surfaceReleased: (surfaceId) => {
      const sessionId = displayedBySurface.get(surfaceId)
      if (sessionId === undefined) return
      displayedBySurface.delete(surfaceId)
      blockedSurfaces.delete(surfaceId)
      visibleSurfaces.delete(surfaceId)
      records.get(sessionId)?.displayedBy.delete(surfaceId)
      evaluate(sessionId)
    },
    attach: (attached) => {
      if (backend === attached) return
      clearBackendState()
      backend = attached
      for (const [surfaceId, sessionId] of displayedBySurface)
        if (visibleSurfaces.has(surfaceId)) record(sessionId).displayedBy.add(surfaceId)
      unsubscribe = attached.events.subscribe(acceptEvent)
      // Surfaces that already display a session resume their follow streams
      // immediately; the directory read below only adds running/pending holds.
      for (const sessionId of records.keys()) {
        evaluate(sessionId)
      }
      seed()
    },
    detach: () => {
      clearBackendState()
    },
    dispose: () => {
      clearBackendState()
      displayedBySurface.clear()
      visibleSurfaces.clear()
      blockedSurfaces.clear()
    },
  }
}
