import type { TimelineNode } from '@dsh-vscode/timeline'
import { isInjectedUserTimelineNode } from './timeline-user-text-facts.js'

type UserMessageNode = Extract<TimelineNode, { readonly kind: 'user-message' }>

export function promptHasAttachments(node: UserMessageNode): boolean {
  return (node.attachments?.length ?? 0) > 0 || (node.images?.length ?? 0) > 0
}

/**
 * The latest prompt the user wrote, which Retry sends again. Context the
 * runtime injected after it (session references, recalled notes) is skipped.
 */
export function latestAuthoredPrompt(nodes: readonly TimelineNode[]): UserMessageNode | undefined {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index]!
    if (
      node.kind === 'user-message' &&
      (node.markdown.trim() !== '' || promptHasAttachments(node)) &&
      !isInjectedUserTimelineNode(node)
    )
      return node
  }
  return undefined
}
