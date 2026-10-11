import type { BackendEvent } from '@dsh-vscode/domain'
import type { TimelineNode } from './nodes.js'

/** A durable ordinary message cannot retire a process-local tool preview. */
function canRetirePreviews(event: BackendEvent): boolean {
  switch (event.type) {
    case 'session.subscribed':
      return event.controlBaseline === false
    case 'connection.lost':
    case 'turn.ended':
    case 'model.retry':
    case 'step.ended':
    case 'assistant.attempt':
    case 'tool.preparing':
      return true
    case 'message.completed':
      return event.interrupted === true
    case 'message.delta':
    case 'reasoning.delta':
      return event.transientAttemptId !== undefined
    default:
      return false
  }
}

/** Remove previews without converting them into failed/cancelled executions. */
export function retireToolPreviews(nodes: TimelineNode[], event: BackendEvent): number | undefined {
  if (!canRetirePreviews(event)) return undefined
  let firstRemoved: number | undefined
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node?.kind !== 'tool' || node.tool.preparation === undefined) continue
    const sameStep =
      'turn' in event && event.turn === node.tool.turn && 'step' in event && event.step === node.tool.step
    const remove =
      (event.type === 'session.subscribed' && event.controlBaseline === false) ||
      event.type === 'connection.lost' ||
      (event.type === 'turn.ended' && event.turn === node.tool.turn) ||
      (event.type === 'model.retry' &&
        event.retry.turn === node.tool.turn &&
        event.retry.step === node.tool.step) ||
      (sameStep &&
        (event.type === 'step.ended' ||
          event.type === 'assistant.attempt' ||
          (event.type === 'message.completed' && event.interrupted === true))) ||
      (sameStep && event.type === 'tool.preparing' && node.tool.preparation.attemptId !== event.attemptId) ||
      (sameStep &&
        (event.type === 'message.delta' || event.type === 'reasoning.delta') &&
        event.transientAttemptId !== undefined &&
        event.transientAttemptId !== node.tool.preparation.attemptId)
    if (remove) {
      nodes.splice(index, 1)
      firstRemoved = index
    }
  }
  return firstRemoved
}
