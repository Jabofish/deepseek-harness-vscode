import { useEffect, useMemo, useRef, useState } from 'react'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { isInjectedUserTimelineNode } from '../chat/timeline-user-text-facts.js'

/** How many previous prompts the composer can walk back through. */
export const PROMPT_HISTORY_LIMIT = 20

const EMPTY_PROMPTS: readonly string[] = []
const EMPTY_OMITTED: readonly string[] = []

/**
 * The prompts this conversation already sent, most recent first.
 *
 * Only durable `user-message` rows are eligible. A question reply is an answer
 * payload rather than a prompt, and a message whose body is empty (an
 * image-only send) has no text to put back in the composer. Exact duplicates
 * collapse onto their latest position so repeated one-word prompts do not fill
 * the whole window.
 */
export function recentPrompts(
  nodes: readonly TimelineNode[],
  omittedNodeIds: readonly string[] = EMPTY_OMITTED,
): readonly string[] {
  const prompts: string[] = []
  const seen = new Set<string>()
  const omitted = new Set(omittedNodeIds)
  for (let index = nodes.length - 1; index >= 0 && prompts.length < PROMPT_HISTORY_LIMIT; index -= 1) {
    const node = nodes[index]
    if (
      node === undefined ||
      node.kind !== 'user-message' ||
      node.questionReply !== undefined ||
      isInjectedUserTimelineNode(node) ||
      omitted.has(node.id)
    )
      continue
    const key = node.markdown.trim()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    prompts.push(node.markdown)
  }
  return prompts.length === 0 ? EMPTY_PROMPTS : prompts
}

/**
 * Preserve the returned list across assistant updates while observing history
 * pagination, replacement, transport clipping and conversation ownership.
 */
export function createRecentPromptsProjector(): (
  nodes: readonly TimelineNode[],
  owner: string,
  omittedNodeIds?: readonly string[],
) => readonly string[] {
  let cache:
    | {
        readonly owner: string
        readonly nodes: readonly TimelineNode[]
        readonly omittedNodeIds: readonly string[]
        readonly prompts: readonly string[]
      }
    | undefined
  return (nodes, owner, omittedNodeIds = EMPTY_OMITTED) => {
    if (cache?.nodes === nodes && cache.owner === owner && cache.omittedNodeIds === omittedNodeIds)
      return cache.prompts
    const next = recentPrompts(nodes, omittedNodeIds)
    const prompts =
      cache?.owner === owner &&
      cache.prompts.length === next.length &&
      next.every((text, index) => text === cache?.prompts[index])
        ? cache.prompts
        : next
    cache = { owner, nodes, omittedNodeIds, prompts }
    return prompts
  }
}

export function useRecentPrompts(
  nodes: readonly TimelineNode[],
  owner = '',
  omittedNodeIds?: readonly string[],
): readonly string[] {
  const project = useMemo(() => createRecentPromptsProjector(), [])
  return project(nodes, owner, omittedNodeIds)
}

export interface PromptHistoryNavigation {
  /** The composer still shows an unedited history entry. */
  readonly browsing: boolean
  /**
   * Move one step through the history. Returns whether the key press belonged
   * to the history: `false` leaves the caret's native movement alone.
   */
  readonly recall: (direction: 'older' | 'newer') => boolean
}

/**
 * Walk back through previously sent prompts from an empty composer.
 *
 * The list is frozen when the walk starts so a prompt accepted while the user
 * browses cannot shift the position under them. Any edit, clear or draft-owner
 * change ends the walk; the next ↑ starts again from the newest prompt.
 */
export function usePromptHistory(props: {
  readonly draft: string
  readonly owner?: string | undefined
  readonly prompts: readonly string[]
  readonly onDraftChange: (value: string) => void
  /** Place the caret after the recalled text. */
  readonly onCursor?: ((offset: number) => void) | undefined
}): PromptHistoryNavigation {
  const { draft, prompts, onDraftChange, onCursor, owner } = props
  const state = useRef<{
    owner: string | undefined
    list: readonly string[]
    index: number | undefined
    saved: string
    expected: string | undefined
  }>({ owner, list: EMPTY_PROMPTS, index: undefined, saved: '', expected: undefined })
  /** Render-visible copy of `state.index !== undefined`: the ref itself is not
   * readable during render. */
  const [browsing, setBrowsing] = useState(false)
  useEffect(() => {
    const current = state.current
    if (current.owner === owner && (current.index === undefined || draft === current.expected)) return
    current.owner = owner
    current.index = undefined
    current.list = EMPTY_PROMPTS
    current.saved = ''
    current.expected = undefined
    setBrowsing(false)
  }, [draft, owner])
  const apply = (text: string): void => {
    state.current.expected = text
    onCursor?.(text.length)
    onDraftChange(text)
  }
  const recall = (direction: 'older' | 'newer'): boolean => {
    const current = state.current
    if (current.owner !== owner) {
      current.owner = owner
      current.index = undefined
      current.list = EMPTY_PROMPTS
      current.saved = ''
      current.expected = undefined
      setBrowsing(false)
    }
    if (direction === 'older') {
      const list = current.index === undefined ? prompts : current.list
      if (list.length === 0) return false
      if (current.index === undefined) {
        current.list = list
        current.saved = draft
        current.index = 0
      } else if (current.index < list.length - 1) current.index += 1
      else return true
      const text = list[current.index]
      if (text === undefined) return true
      apply(text)
      setBrowsing(true)
      return true
    }
    if (current.index === undefined) return false
    if (current.index > 0) {
      current.index -= 1
      const text = current.list[current.index]
      if (text === undefined) return true
      apply(text)
      return true
    }
    current.index = undefined
    const restored = current.saved
    current.list = EMPTY_PROMPTS
    current.saved = ''
    apply(restored)
    setBrowsing(false)
    return true
  }
  return { browsing, recall }
}
