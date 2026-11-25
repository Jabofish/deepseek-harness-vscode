import { describe, expect, it } from 'vitest'
import type { TimelineNode } from '@dsh-vscode/timeline'
import { latestAuthoredPrompt } from './retry-prompt.js'

describe('latestAuthoredPrompt', () => {
  it('returns the prompt the user wrote, not the context injected after it', () => {
    const nodes: readonly TimelineNode[] = [
      { kind: 'user-message', id: 'old', markdown: 'Older prompt', source: 'user' },
      { kind: 'user-message', id: 'prompt', markdown: 'Fix the build', source: 'user' },
      { kind: 'user-message', id: 'context', markdown: 'recalled context', source: 'session-reference' },
      { kind: 'user-message', id: 'blank', markdown: '   ', source: 'user' },
      { kind: 'turn-terminal', id: 'end', turn: 2, sequence: 9, reason: 'error' },
    ]
    expect(latestAuthoredPrompt(nodes)?.id).toBe('prompt')
  })

  it('returns nothing when no prompt was written', () => {
    expect(latestAuthoredPrompt([])).toBeUndefined()
  })
})
