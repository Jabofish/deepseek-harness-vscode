import type { FocusedWorkNode, PresentedTimelineNode } from './focused-timeline-projection.js'
import { assistantMessageId } from './timeline-shared.js'

export function rowCopyNeedsFullContent(node: PresentedTimelineNode, omitted: ReadonlySet<string>): boolean {
  return copyParts(node).some((part) => omitted.has(part.id))
}

/** Resolve each omitted source, rather than copying the combined preview. */
export async function loadRowCopyMarkdown(
  node: PresentedTimelineNode,
  omitted: ReadonlySet<string>,
  load: (id: string) => Promise<string>,
): Promise<string | undefined> {
  if (!rowCopyNeedsFullContent(node, omitted)) return rowCopyMarkdown(node)
  const parts: string[] = []
  for (const part of copyParts(node)) {
    if (omitted.has(part.id)) {
      parts.push(await load(part.id))
    } else parts.push(part.markdown)
  }
  return readableMarkdown(parts.join('\n\n'))
}

function copyParts(
  node: PresentedTimelineNode,
): readonly { id: string; markdown: string; streaming?: boolean }[] {
  switch (node.kind) {
    case 'user-message':
    case 'assistant-message':
      return readableMarkdown(node.markdown) === undefined ? [] : [node]
    case 'assistant-turn': {
      const messages = node.blocks
        .filter((block) => block.kind === 'message')
        .filter((block) => readableMarkdown(block.markdown) !== undefined)
      return node.blocks.length > 0
        ? messages
        : [{ id: assistantMessageId(node) ?? node.id, markdown: node.markdown, streaming: node.streaming }]
    }
    case 'focused-turn':
      return node.answer === undefined ? node.nodes.flatMap(copyParts) : copyParts(node.answer)
    default:
      return []
  }
}

/**
 * The Markdown a transcript row publishes for a reader, or `undefined` when
 * the row holds nothing readable.
 *
 * Reasoning, tool calls, notices and statistics stay out. Answer rows publish
 * the same Markdown their own copy button offers (`assistant-message`,
 * `assistant-turn`, `user-message`); a focused turn has no such button, so it
 * publishes its settled answer, or the text of its grouped messages while it
 * runs. Markdown rather than rendered text is intentional — pasting a response
 * keeps its headings, lists and code fences.
 */
export function rowCopyMarkdown(node: PresentedTimelineNode): string | undefined {
  switch (node.kind) {
    case 'assistant-message':
    case 'assistant-turn':
    case 'user-message':
      return readableMarkdown(node.markdown)
    case 'focused-turn':
      // A settled answer is the whole answer, even when it carries only
      // images: its absent text is a strict no-op, never the process text of
      // the messages that produced it.
      if (node.answer !== undefined) return readableMarkdown(node.answer.markdown)
      return groupedMessageMarkdown(node.nodes)
    default:
      return undefined
  }
}

function groupedMessageMarkdown(nodes: readonly FocusedWorkNode[]): string | undefined {
  const parts: string[] = []
  for (const node of nodes) {
    if (node.kind !== 'assistant-message' && node.kind !== 'assistant-turn') continue
    const markdown = readableMarkdown(node.markdown)
    if (markdown !== undefined) parts.push(markdown)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

function readableMarkdown(markdown: string): string | undefined {
  // Whitespace-only answers count as absent: a caller must be able to tell
  // "nothing to copy" from "copy an empty string", because writing empty text
  // would clear a clipboard the user never asked to change.
  return markdown.trim() === '' ? undefined : markdown
}
