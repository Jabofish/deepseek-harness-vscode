// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

// `createBundledHighlighter` runs once when the module loads; the function it
// returns is the factory every `getWebviewHighlighter()` call exercises.
const createHighlighter = vi.fn()

vi.mock('shiki/core', () => ({ createBundledHighlighter: vi.fn(() => createHighlighter) }))

const highlighter = {
  loadLanguage: vi.fn(),
  codeToHtml: vi.fn(),
  codeToTokensWithThemes: vi.fn(),
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('getWebviewHighlighter', () => {
  it('retries after a transient load failure instead of caching the rejection', async () => {
    createHighlighter
      .mockRejectedValueOnce(new Error('failed to fetch dynamically imported module'))
      .mockResolvedValueOnce(highlighter)
    const html = '<pre><code>const answer = 42</code></pre>'
    highlighter.codeToHtml.mockReturnValue(html)
    const { getWebviewHighlighter, requestCodeHighlight, cachedCodeHighlight } = await import('./shiki.js')

    await expect(getWebviewHighlighter()).rejects.toThrow('failed to fetch dynamically imported module')
    // The chat keeps rendering after a failed grammar chunk; the next code block
    // must be able to highlight once the load succeeds.
    requestCodeHighlight('typescript', 'const answer = 42')
    await vi.waitFor(() => expect(cachedCodeHighlight('typescript', 'const answer = 42')).toBe(html))
  })
})
