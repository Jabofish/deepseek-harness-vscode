import { describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { createUserTextFactsProjector } from './timeline-projection.js'

const user = (id: string): Extract<TimelineNode, { kind: 'user-message' }> => ({
  kind: 'user-message',
  id,
  markdown: 'fixture',
})
const reference = (id: string, labels: readonly string[]): TimelineNode => ({
  kind: 'user-message',
  id,
  markdown: 'fixture',
  source: 'session-reference',
  sessionReferenceLabels: labels,
})

describe('incremental user reference projection', () => {
  it('does not revisit an unchanged immutable snapshot', () => {
    let reads = 0
    const nodes: readonly TimelineNode[] = [
      {
        ...user('user'),
        get kind(): 'user-message' {
          reads += 1
          return 'user-message'
        },
      },
      reference('context', ['Referenced session']),
    ]
    const project = createUserTextFactsProjector()
    const facts = project(nodes)
    reads = 0
    expect(project(nodes)).toBe(facts)
    expect(reads).toBe(0)
  })

  it('keeps old user rows untouched during tail streaming with a matching change base', () => {
    let oldRowReads = 0
    const stable: readonly TimelineNode[] = Array.from({ length: 1000 }, (_, index) => ({
      ...user(`user-${index}`),
      get kind(): 'user-message' {
        oldRowReads += 1
        return 'user-message'
      },
    }))
    const previous: readonly TimelineNode[] = [
      ...stable,
      reference('context', ['Referenced session']),
      { kind: 'assistant-message', id: 'answer', markdown: 'first', streaming: true },
    ]
    const project = createUserTextFactsProjector()
    const facts = project(previous)
    oldRowReads = 0
    const current: readonly TimelineNode[] = [
      ...previous.slice(0, -1),
      { kind: 'assistant-message', id: 'answer', markdown: 'first second', streaming: true },
    ]
    expect(project(current, 1001, previous)).toBe(facts)
    expect(oldRowReads).toBeLessThan(8)
  })

  it('updates a preceding user when context is appended or removed and rebuilds after prepend or replacement', () => {
    const project = createUserTextFactsProjector()
    const first = [user('user')]
    expect(project(first).size).toBe(0)
    const enriched = [...first, reference('context', ['One', 'One', 'Two'])]
    expect(project(enriched, 1, first).get('user')?.sessionReferenceLabels).toEqual(['One', 'Two'])
    expect(project(first, 1, enriched).size).toBe(0)
    const prepended = [user('older'), reference('older-context', ['Older']), ...enriched]
    expect([...project(prepended).keys()]).toEqual(['older', 'user'])
    const replacement = [user('other'), reference('other-context', ['Other'])]
    expect([...project(replacement, 1, enriched)]).toEqual([['other', { sessionReferenceLabels: ['Other'] }]])
  })

  it('preserves the first 32 unique labels and never attaches context across assistant rows', () => {
    const labels = Array.from({ length: 40 }, (_, index) => `session-${index}`)
    const nodes: readonly TimelineNode[] = [
      user('user'),
      reference('one', labels.slice(0, 20)),
      reference('two', labels),
      { kind: 'assistant-message', id: 'answer', markdown: 'done', streaming: false },
      reference('late', ['Late']),
    ]
    expect(createUserTextFactsProjector()(nodes).get('user')?.sessionReferenceLabels).toEqual(
      labels.slice(0, 32),
    )
  })
})
