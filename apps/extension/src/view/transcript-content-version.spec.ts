import { expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { TranscriptContentVersions } from './transcript-content-version.js'

it('fingerprints complete bodies and reuses equal baselines without mixing retained branches', () => {
  const versions = new TranscriptContentVersions()
  const node = (markdown: string): Extract<TimelineNode, { kind: 'assistant-message' }> => ({
    kind: 'assistant-message',
    id: 'm',
    streaming: true,
    markdown,
  })
  const first = node('before\ud83d')
  const original = versions.key(first)
  const left = node(first.markdown + '\ude00')
  const right = node(first.markdown + 'x')
  versions.append(first, left, node('\ude00'))
  versions.append(first, right, node('x'))
  expect(versions.key(left)).toBe(new TranscriptContentVersions().key({ ...left }))
  expect(versions.key(right)).toBe(new TranscriptContentVersions().key({ ...right }))
  expect(versions.key(left)).not.toBe(versions.key(right))
  expect(versions.key(first)).toBe(original)
  expect(versions.key({ ...first, streaming: false })).not.toBe(original)
})

it('tracks reasoning appends and nontext fields even if their visible text stays unchanged', () => {
  const versions = new TranscriptContentVersions()
  const first: Extract<TimelineNode, { kind: 'assistant-message' }> = {
    kind: 'assistant-message',
    id: 'm',
    streaming: true,
    markdown: 'answer',
    reasoning: { markdown: 'reason', streaming: true },
  }
  versions.key(first)
  const next = { ...first, reasoning: { ...first.reasoning!, markdown: 'reason suffix' } }
  versions.append(first, next, {
    ...next,
    markdown: '',
    reasoning: { ...next.reasoning, markdown: ' suffix' },
  })
  expect(versions.key(next)).toBe(new TranscriptContentVersions().key(next))
  expect(versions.key({ ...next, reasoning: { ...next.reasoning, streaming: false } })).not.toBe(
    versions.key(next),
  )
  expect(versions.key({ ...first, markdown: 'answer hidden A' })).not.toBe(
    versions.key({ ...first, markdown: 'answer hidden B' }),
  )
})
