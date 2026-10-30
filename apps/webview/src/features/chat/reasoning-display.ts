import type { TimelineNode } from '@dsh-vscode/timeline'

/** dsh-v0.2.1-rc.5 reasoning-text.ts: hide only the leading signature envelope. */
export function reasoningDisplayText(raw: string): string {
  if (raw[0] !== '<') return raw
  const opening = '<signature>'
  if (opening.startsWith(raw)) return ''
  if (!raw.startsWith(opening)) return raw
  const closing = '</signature>'
  const end = raw.indexOf(closing, opening.length)
  if (end < 0) return ''
  let start = end + closing.length
  while (start < raw.length) {
    if (raw[start] === '\n') start++
    else if (raw[start] === '\r' && raw[start + 1] === '\n') start += 2
    else break
  }
  return raw.slice(start)
}

type DisplaySource = Exclude<TimelineNode, { readonly kind: 'event' }>
const displayNodes = new WeakMap<DisplaySource, DisplaySource>()

/** Prepare each source before grouping; the authoritative history stays raw. */
export function reasoningDisplayNode(node: DisplaySource): DisplaySource {
  const cached = displayNodes.get(node)
  if (cached !== undefined) return cached
  if (node.kind === 'reasoning') {
    const markdown = reasoningDisplayText(node.markdown)
    if (markdown === node.markdown) return node
    const display = { ...node, markdown }
    displayNodes.set(node, display)
    return display
  }
  if (node.kind === 'assistant-message' && node.reasoning !== undefined) {
    const markdown = reasoningDisplayText(node.reasoning.markdown)
    if (markdown === node.reasoning.markdown) return node
    const display = { ...node, reasoning: { ...node.reasoning, markdown } }
    displayNodes.set(node, display)
    return display
  }
  return node
}
