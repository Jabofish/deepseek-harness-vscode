import { describe, expect, it } from 'vitest'
import { readConversationLayout, rememberConversationLayout } from './conversation-layout.js'

describe('frontend conversation layout preference', () => {
  it('restores the classic preference and rejects unknown persisted values', () => {
    expect(readConversationLayout({ getItem: () => 'classic', setItem: () => undefined })).toBe('classic')
    for (const value of [null, 'compact', 'corrupt'])
      expect(readConversationLayout({ getItem: () => value, setItem: () => undefined })).toBe('focused')
  })
  it('stays usable when the browser denies reads and writes', () => {
    const storage = {
      getItem: (): never => {
        throw new Error('blocked')
      },
      setItem: (): never => {
        throw new Error('blocked')
      },
    }
    expect(readConversationLayout(storage)).toBe('focused')
    expect(() => rememberConversationLayout('classic', storage)).not.toThrow()
  })
})
