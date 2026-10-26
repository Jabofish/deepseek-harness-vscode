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
