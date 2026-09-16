import type { PermissionRequest } from '@dsh-vscode/domain'
import type { TimelineNode } from '@dsh-vscode/timeline'

/**
 * The command an approval asks the user to authorize.
 *
 * The host's `approval/requested` carries `{ toolName, callId?, reason? }` and
 * no command: DSH's own approval panel resolves it from the running tool call
 * the request is paired with (`commandOf` over the call's `args.command`),
 * because a shell call card's title IS the command (`presentCall: args => ({
 * card: 'terminal', title: args.command })`). Requesting a decision without it
 * asks the user to authorize text they cannot read, so the resolution happens
 * here — at render time, over the current timeline, which also lets a request
 * that arrives before its call fill in as soon as the call lands.
 */
export function approvalCommand(
  request: PermissionRequest,
  nodes: readonly TimelineNode[],
): string | undefined {
  // A host that does supply a preview means it: it is the command as the host
  // parsed it, without depending on our own call projection.
  if (request.commandLine !== undefined) return request.commandLine
  if (request.callId === undefined) return undefined
  const node = nodes.find((entry) => entry.kind === 'tool' && entry.id === request.callId)
  if (node?.kind !== 'tool') return undefined
  const presentation = node.tool.presentation
  // Only a command card names a command. A diff or generic card's title is a
  // file path or a tool label, and presenting it as the authorized command
  // would invent one.
  if (presentation?.card !== 'terminal') return undefined
  return presentation.title
}
