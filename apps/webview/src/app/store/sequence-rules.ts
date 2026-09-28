import type { BackendEvent } from '@dsh-vscode/domain'

function isHostOnlyInterruptedCompletion(event: BackendEvent): boolean {
  return event.type === 'message.completed' && event.interrupted === true && event.sequence === undefined
}

/** Only durable conversation records advance the DSH timeline cursor. */
function advancesTimelineSequence(event: BackendEvent): boolean {
  switch (event.type) {
    case 'archived.sessions.changed':
    case 'connection.lost':
    case 'jobs.updated':
    case 'job.follow.updated':
    case 'job.follow.failed':
    case 'permission.requested':
    case 'permission.resolved':
    case 'question.requested':
    case 'question.resolved':
    case 'queue.updated':
    case 'session.added':
    case 'session.activity':
    case 'session.configuration':
    case 'session.projection.baseline':
    case 'session.projection':
    case 'session.removed':
    case 'session.status':
    case 'session.subscribed':
    case 'session.system':
    case 'session.title':
    case 'workspace.changed':
    case 'workspace.order.changed':
    case 'workspace.removed':
    case 'remote.event':
      return false
    case 'unknown':
      // An uninterpreted frame is preserved as a raw event row, but it must
      // never spend a durable cursor slot. DSH legitimately carries several
      // rows in one sequence (projections, replay races), so a row this build
      // cannot read must not make a renderable neighbour look stale.
      return false
    default:
      return true
  }
}

/**
 * Keep the live and history-replay cursor rules identical.
 *
 * A streamed delta can carry the durable frame sequence as transport
 * metadata, but it is still only a transient projection of the assistant
 * message. If replay lets that delta consume the cursor, the durable
 * `message.completed` frame at the same sequence is rejected as stale and
 * the completed answer disappears after a ledger rebuild.
 */
export function timelineSequenceOptions(event: BackendEvent): { readonly advanceSequence?: false } {
  const transientSequence =
    event.type === 'message.delta' || event.type === 'reasoning.delta' ? event.transientSequence : undefined
  return !advancesTimelineSequence(event) ||
    transientSequence !== undefined ||
    isHostOnlyInterruptedCompletion(event)
    ? { advanceSequence: false }
    : {}
}
