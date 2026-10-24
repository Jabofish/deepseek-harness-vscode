import type { TimelineNode } from './nodes.js'

type TextNode = Extract<TimelineNode, { kind: 'assistant-message' | 'reasoning' }>

/**
 * Exact JSON size after appending text. The suffix node replaces every field
 * except the accumulated text, so its metadata must be measured as well.
 * Callers establish the append from reducer semantics or patch base lengths.
 */
export function appendedTextNodeChars(previous: TextNode, suffix: TextNode, previousChars: number): number {
  const oldReasoning = previous.kind === 'assistant-message' ? previous.reasoning : undefined
  const newReasoning = suffix.kind === 'assistant-message' ? suffix.reasoning : undefined
  const emptyPrevious = {
    ...previous,
    markdown: '',
    ...(oldReasoning === undefined ? {} : { reasoning: { ...oldReasoning, markdown: '' } }),
  }
  return (
    previousChars +
    JSON.stringify(suffix).length -
    JSON.stringify(emptyPrevious).length -
    joinedSurrogateChars(previous.markdown, suffix.markdown) -
    (newReasoning === undefined
      ? oldReasoning === undefined
        ? 0
        : JSON.stringify(oldReasoning.markdown).length - 2
      : joinedSurrogateChars(oldReasoning?.markdown ?? '', newReasoning.markdown))
  )
}

function joinedSurrogateChars(prefix: string, suffix: string): number {
  const high = prefix.charCodeAt(prefix.length - 1)
  const low = suffix.charCodeAt(0)
  // Two separately escaped lone surrogates (12 JSON chars) become one pair (2).
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? 10 : 0
}
