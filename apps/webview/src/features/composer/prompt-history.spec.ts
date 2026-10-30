// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import {
  PROMPT_HISTORY_LIMIT,
  createRecentPromptsProjector,
  recentPrompts,
  usePromptHistory,
  type PromptHistoryNavigation,
} from './prompt-history.js'

const user = (id: string, markdown: string, extra: Partial<TimelineNode> = {}): TimelineNode =>
  ({ kind: 'user-message', id, markdown, ...extra }) as TimelineNode

const answer = (id: string): TimelineNode => ({
  kind: 'assistant-message',
  id,
  markdown: 'answer',
  streaming: false,
})

describe('prompt history derivation', () => {
  it('excludes injected context, question replies and clipped prompt bodies', () => {
    const nodes = [
      user('authored', 'A complete user prompt'),
      user('context', 'Host-injected context', { source: 'plugin' }),
      user('clipped', 'Only a partial prefix'),
      user('question', 'An answer to a question', {
        questionReply: { callId: 'q', questions: [], answers: [] },
      }),
    ]
    expect(recentPrompts(nodes, ['clipped'])).toEqual(['A complete user prompt'])
  })

  it('observes older history and owners even when the newest message ID is reused', () => {
    const project = createRecentPromptsProjector()
    const latest = user('latest', 'Latest prompt')
    const first = project([latest], 'connection-a:session-a')
    expect(project([latest, answer('stream')], 'connection-a:session-a')).toBe(first)
    expect(project([user('older', 'Older prompt'), latest], 'connection-a:session-a')).toEqual([
      'Latest prompt',
      'Older prompt',
    ])
    expect(project([user('latest', 'Other conversation')], 'connection-b:session-b')).toEqual([
      'Other conversation',
    ])
  })
  it('lists sent prompts newest first and skips payloads with nothing to recall', () => {
    const nodes: TimelineNode[] = [
      user('u1', 'first'),
      answer('a1'),
      user('u2', 'second'),
      answer('a2'),
      user('u3', ''),
      user('u4', 'second'),
      user('u5', 'question answer', {
        questionReply: { callId: 'call', questions: [], answers: [] },
      }),
    ]
    expect(recentPrompts(nodes)).toEqual(['second', 'first'])
  })

  it('bounds the window and reports an empty list when nothing was sent', () => {
    const nodes = Array.from({ length: PROMPT_HISTORY_LIMIT + 5 }, (_, index) =>
      user(`u${index}`, `prompt ${index}`),
    )
    const prompts = recentPrompts(nodes)
    expect(prompts).toHaveLength(PROMPT_HISTORY_LIMIT)
    expect(prompts[0]).toBe(`prompt ${PROMPT_HISTORY_LIMIT + 4}`)
    expect(recentPrompts([answer('a')])).toEqual([])
  })
})

describe('composer prompt history walk', () => {
  const prompts = ['newest', 'middle', 'oldest']

  function harness(
    initialDraft = '',
    list: readonly string[] = prompts,
  ): {
    readonly changes: readonly string[]
    readonly edit: (value: string) => void
    readonly hook: { readonly result: { readonly current: PromptHistoryNavigation } }
    readonly onCursor: ReturnType<typeof vi.fn>
    readonly press: (direction: 'older' | 'newer') => boolean
    readonly rerender: (next?: readonly string[]) => void
  } {
    let draft = initialDraft
    const changes: string[] = []
    const onCursor = vi.fn()
    const onDraftChange = vi.fn((value: string) => {
      draft = value
      changes.push(value)
    })
    const hook = renderHook(
      (props: { readonly draft: string; readonly prompts: readonly string[] }) =>
        usePromptHistory({
          draft: props.draft,
          prompts: props.prompts,
          onDraftChange,
          onCursor,
        }),
      { initialProps: { draft, prompts: list } },
    )
    const rerender = (next = list): void => {
      hook.rerender({ draft, prompts: next })
    }
    const press = (direction: 'older' | 'newer'): boolean => {
      let handled = false
      act(() => {
        handled = hook.result.current.recall(direction)
      })
      rerender()
      return handled
    }
    const edit = (value: string): void => {
      draft = value
      rerender()
    }
    return { changes, edit, hook, onCursor, press, rerender }
  }

  it('walks back to the oldest prompt and restores the draft on the way down', () => {
    const { changes, hook, onCursor, press } = harness()
    expect(hook.result.current.browsing).toBe(false)
    expect(press('newer')).toBe(false)

    expect(press('older')).toBe(true)
    expect(changes).toEqual(['newest'])
    expect(hook.result.current.browsing).toBe(true)
    expect(onCursor).toHaveBeenLastCalledWith('newest'.length)

    expect(press('older')).toBe(true)
    expect(changes).toEqual(['newest', 'middle'])
    expect(press('older')).toBe(true)
    expect(changes).toEqual(['newest', 'middle', 'oldest'])
    // The oldest entry stays put instead of wrapping to the newest.
    expect(press('older')).toBe(true)
    expect(changes).toEqual(['newest', 'middle', 'oldest'])

    expect(press('newer')).toBe(true)
    expect(changes.at(-1)).toBe('middle')
    expect(press('newer')).toBe(true)
    expect(changes.at(-1)).toBe('newest')
    expect(press('newer')).toBe(true)
    expect(changes.at(-1)).toBe('')
    expect(hook.result.current.browsing).toBe(false)
    expect(press('newer')).toBe(false)
  })

  it('keeps the list frozen while browsing and ends the walk on an edit', () => {
    const { changes, edit, hook, press, rerender } = harness('', prompts)
    expect(press('older')).toBe(true)
    expect(changes.at(-1)).toBe('newest')

    // A prompt accepted while the user browses must not shift the position.
    rerender(['arrived', ...prompts])
    expect(press('older')).toBe(true)
    expect(changes.at(-1)).toBe('middle')

    edit('middle edited')
    expect(hook.result.current.browsing).toBe(false)
    // The edited draft is the text a fresh walk would restore.
    expect(press('older')).toBe(true)
    expect(changes.at(-1)).toBe('newest')
    expect(press('newer')).toBe(true)
    expect(changes.at(-1)).toBe('middle edited')
  })

  it('does not consume the key when the conversation has no prompts', () => {
    const { hook, press } = harness('', [])
    expect(press('older')).toBe(false)
    expect(hook.result.current.browsing).toBe(false)
  })
})
