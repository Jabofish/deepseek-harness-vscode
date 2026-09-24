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
    const { getWebviewHighlighter } = await import('./shiki.js')

    await expect(getWebviewHighlighter()).rejects.toThrow('failed to fetch dynamically imported module')
    // The chat keeps rendering after a failed grammar chunk; the next code block
    // must be able to highlight once the load succeeds.
    await expect(getWebviewHighlighter()).resolves.toBe(highlighter)
    expect(createHighlighter).toHaveBeenCalledTimes(2)
  })

  it('shares one highlighter across concurrent and later callers', async () => {
    createHighlighter.mockResolvedValue(highlighter)
    const { getWebviewHighlighter } = await import('./shiki.js')

    const [first, second] = await Promise.all([getWebviewHighlighter(), getWebviewHighlighter()])

    expect(first).toBe(highlighter)
    expect(second).toBe(highlighter)
    expect(await getWebviewHighlighter()).toBe(highlighter)
    expect(createHighlighter).toHaveBeenCalledTimes(1)
  })
})

describe('resolveBundledLanguage', () => {
  it('keeps the bounded grammar set and their common aliases', async () => {
    const { resolveBundledLanguage } = await import('./shiki.js')

    expect(resolveBundledLanguage('TS')).toBe('typescript')
    expect(resolveBundledLanguage('tsx')).toBe('tsx')
    expect(resolveBundledLanguage(' bash ')).toBe('shell')
    expect(resolveBundledLanguage('md')).toBe('markdown')
  })

  it('returns undefined for every language outside the bounded set', async () => {
    const { resolveBundledLanguage } = await import('./shiki.js')

    // Shiki's full bundle would have loaded these; the Webview must instead fall
    // back to plaintext rather than request a grammar it never shipped.
    expect(resolveBundledLanguage('emacs-lisp')).toBeUndefined()
    expect(resolveBundledLanguage('wolfram')).toBeUndefined()
    expect(resolveBundledLanguage('text')).toBeUndefined()
    expect(resolveBundledLanguage('   ')).toBeUndefined()
    expect(resolveBundledLanguage(undefined)).toBeUndefined()
  })
})

describe('code highlights', () => {
  it('tokenizes each distinct code text once and reports the completion', async () => {
    createHighlighter.mockResolvedValue(highlighter)
    highlighter.codeToHtml.mockReturnValue('<pre class="shiki"><code>1</code></pre>')
    const { cachedCodeHighlight, codeHighlightVersion, requestCodeHighlight } = await import('./shiki.js')
    const version = codeHighlightVersion()

    expect(cachedCodeHighlight('typescript', 'const a = 1')).toBeUndefined()
    requestCodeHighlight('typescript', 'const a = 1')
    // A streaming block re-renders far more often than it needs a tokenizer run.
    requestCodeHighlight('typescript', 'const a = 1')
    await vi.waitFor(() => expect(codeHighlightVersion()).toBe(version + 1))

    expect(highlighter.codeToHtml).toHaveBeenCalledTimes(1)
    expect(cachedCodeHighlight('typescript', 'const a = 1')).toBe('<pre class="shiki"><code>1</code></pre>')
    expect(cachedCodeHighlight('typescript', 'const a = 2')).toBeUndefined()
  })

  it('keeps a failed highlight retryable and leaves the block readable', async () => {
    createHighlighter.mockResolvedValue(highlighter)
    highlighter.codeToHtml.mockImplementationOnce(() => {
      throw new Error('grammar chunk unavailable')
    })
    const { cachedCodeHighlight, requestCodeHighlight } = await import('./shiki.js')

    requestCodeHighlight('python', 'print(1)')
    await vi.waitFor(() => expect(cachedCodeHighlight('python', 'print(1)')).toBeNull())

    // A cached failure stops the next render from retrying immediately; the
    // caller keeps the block as plaintext until the retry window clears it.
    requestCodeHighlight('python', 'print(1)')
    expect(highlighter.codeToHtml).toHaveBeenCalledTimes(1)
  })
})
